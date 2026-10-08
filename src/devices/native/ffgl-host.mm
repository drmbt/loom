// VN85: a native FFGL host. dlopens a Resolume FFGL `.bundle`, owns one CGL OpenGL 4.1 core
// context per plugin instance, and processes an input IOSurface into an addon-owned output
// IOSurface, exactly the lifecycle Resolume drives (drmbt-custom-fx/tools/ffgl_smoketest.cpp:
// FF_INITIALISE_V2 → FF_INSTANTIATE_GL → FF_PROCESS_OPENGL … → FF_DEINSTANTIATE_GL →
// FF_DEINITIALISE). Design: docs/ffgl-host-design-2026-10-08.md.
//
// TIME. FFGL hands the host's time to a plugin through FF_SET_TIME, and the SDK stores it in
// `hostTime` and nothing reads it: ffglqs::Plugin::UpdateAudioAndTime() takes `timeNow` from
// std::chrono::high_resolution_clock (FFGLPlugin.cpp:113), which every drmbt effect forwards to
// its shader. So the caller's time could not reach an unmodified binary. After dlopen the host
// rewrites THAT ONE IMAGE's own symbol pointers for steady_clock::now, rand and
// random_device::operator() (`rebindImage`, fishhook's technique scoped to a single Mach-O), so
// inside a plugMain call they answer the frame time the caller passed and a per-instance seeded
// sequence. Nothing else in the process is touched. When the rebind does not take, the instance
// reports clock "wallclock" and its output is not reproducible; it is never silently assumed.
//
// THE PLUGIN'S CLOCK (pluginClock below). drmbt effects are written for Arena's FREE clock: their
// simulations integrate dt per frame, so the time a plugin sees must behave like one: never
// backwards, one frame interval per frame, no huge dt. The caller's time drives it, with seeks
// absorbed:
//   * first frame after open, or `reset` (a render take restarting): clock = max(0, time);
//   * a forward step 0 < d <= 8 intervals: clock += d (real time, dropped frames included);
//   * d == 0 (the same frame cooked again): clock unchanged, so a re-cook is deterministic;
//   * a backward seek, or a forward jump beyond 8 intervals: clock += ONE interval.
// So the frame after any seek is exactly the frame a normal one-interval step would give.
// Design and the reasoning: docs/ffgl-host-design-2026-10-08.md, "The plugin clock".
//
// ORIENTATION. A Chromium capture surface is top row first. FFGL plugins are OpenGL programs
// and see their input bottom row first, as in Resolume. The input blit flips rows; the output
// surface is therefore bottom row first, which is Syphon's layout (VNB13), and the page imports
// it with flipY.
//
// THREADING. Every GL and plugMain call runs on a libuv worker under one process-wide mutex,
// never on Electron's main thread. A context is current only for the duration of one job.
//
// What a misbehaving plugin can do is reported, not fatal, wherever it is catchable: a failed
// instantiate, a C++ exception out of plugMain, a GL error, a bad parameter index. A plugin that
// crashes the process still crashes it (process isolation is a separate row).
#include <node_api.h>
#define GL_SILENCE_DEPRECATION 1
#include <OpenGL/OpenGL.h>
#include <OpenGL/CGLIOSurface.h>
#include <OpenGL/gl3.h>
#import <IOSurface/IOSurface.h>
#import <Foundation/Foundation.h>
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <mach-o/loader.h>
#include <mach-o/nlist.h>
#include <mach/mach.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <climits>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <random>
#include <stdexcept>
#include <string>
#include <vector>
#include <sys/resource.h>

namespace {

// ---- The FFGL 2.x ABI, by value (FFGL.h, Resolume's BSD-licensed SDK). Only what this host calls.
typedef uint32_t FFUInt32;
typedef uint64_t FFUInt64;
typedef union FFMixed { FFUInt32 UIntValue; void *PointerValue; } FFMixed;
typedef FFMixed (*FFMain)(FFUInt32, FFMixed, void *);
typedef void (*FFLogCallback)(const char *);
typedef void (*FFSetLogCallback)(FFLogCallback);
constexpr FFUInt32 FF_SUCCESS = 0, FF_FAIL = 0xFFFFFFFF;
constexpr FFUInt32 FF_GET_INFO = 0, FF_DEINITIALISE = 2, FF_GET_NUM_PARAMETERS = 4, FF_GET_PARAMETER_NAME = 5,
  FF_GET_PARAMETER_DEFAULT = 6, FF_SET_PARAMETER = 8, FF_GET_PARAMETER = 9, FF_GET_PLUGIN_CAPS = 10,
  FF_GET_EXTENDED_INFO = 13, FF_GET_PARAMETER_TYPE = 15, FF_PROCESS_OPENGL = 17, FF_INSTANTIATE_GL = 18,
  FF_DEINSTANTIATE_GL = 19, FF_SET_TIME = 20, FF_GET_NUM_PARAMETER_ELEMENTS = 31, FF_INITIALISE_V2 = 34,
  FF_GET_PARAMETER_ELEMENT_NAME = 35, FF_GET_PARAMETER_ELEMENT_VALUE = 36, FF_SET_BEATINFO = 38,
  FF_SET_HOSTINFO = 39, FF_GET_RANGE = 41, FF_GET_PRAMETER_VISIBILITY = 45, FF_GET_PARAM_GROUP = 50;
constexpr FFUInt32 FF_CAP_SET_TIME = 5, FF_CAP_MINIMUM_INPUT_FRAMES = 10, FF_CAP_MAXIMUM_INPUT_FRAMES = 11;
constexpr FFUInt32 FF_TYPE_EVENT = 1, FF_TYPE_OPTION = 11, FF_TYPE_FILE = 14, FF_TYPE_TEXT = 100;
struct PluginInfoStruct { FFUInt32 APIMajorVersion, APIMinorVersion; char PluginUniqueID[4]; char PluginName[16]; FFUInt32 PluginType; };
struct PluginExtendedInfoStruct { FFUInt32 PluginMajorVersion, PluginMinorVersion; const char *Description, *About;
  FFUInt32 FreeFrameExtendedDataSize; void *FreeFrameExtendedDataBlock; };
struct SetParameterStruct { FFUInt32 ParameterNumber; FFMixed NewParameterValue; };
struct SetBeatinfoStruct { float bpm, barPhase; };
struct SetHostinfoStruct { const char *name, *version; };
struct GetRangeStruct { FFUInt32 parameterNumber; struct { float min, max; } range; };
struct GetStringStruct { FFUInt32 parameterNumber; struct { char *address; FFUInt32 maxToWrite; } stringBuffer; };
struct FFGLViewportStruct { GLuint x, y, width, height; };
struct FFGLTextureStruct { FFUInt32 Width, Height, HardwareWidth, HardwareHeight; GLuint Handle; };
struct ProcessOpenGLStruct { FFUInt32 numInputTextures; FFGLTextureStruct **inputTextures; GLuint HostFBO; };
struct GetParameterElementStruct { FFUInt32 ParameterNumber, ElementNumber; };

constexpr uint32_t kBGRA = 0x42475241;
constexpr size_t kOutputSlots = 2;
// The rebound clock reads `kClockBase + frame time`. The base keeps a time_point well away
// from zero so no plugin arithmetic on it underflows.
constexpr double kClockBase = 1000000.0;

struct Instance;
struct Library;
// The instance whose plugMain call is on this thread right now; the rebound symbols read it.
thread_local Instance *tCurrent = nullptr;
// Guards OutputSlot::lease and OutputSlot::surface ownership, which the JS thread (release)
// and a worker (process, close) both touch. Never held across GL work.
std::mutex leaseMutex;

uint32_t nextRandom(uint64_t &state) {
  // splitmix64: a fixed, documented sequence per seed.
  uint64_t z = (state += 0x9E3779B97F4A7C15ull);
  z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
  z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
  return (uint32_t)((z ^ (z >> 31)) >> 32);
}

struct OutputSlot {
  IOSurfaceRef surface = nullptr;
  GLuint texture = 0, framebuffer = 0;
  std::string lease;
};

struct Library {
  std::string path;
  void *handle = nullptr;
  FFMain main = nullptr;
  int references = 0;
  bool initialised = false;
  int reboundClock = 0, reboundRand = 0, reboundRandomDevice = 0;
  bool importsClock = false, importsRand = false, importsRandomDevice = false;
};

struct Instance {
  std::shared_ptr<Library> library;
  CGLContextObj context = nullptr;
  void *ffInstance = nullptr;
  uint32_t width = 0, height = 0;
  GLuint inputRect = 0, input2D = 0, inputFramebuffer = 0, program = 0, vertexArray = 0, timer = 0;
  GLint sizeLocation = -1;
  OutputSlot slots[kOutputSlots];
  // The plugin's clock (what the rebound steady_clock answers), and the caller time it last saw.
  double hostTime = 0;
  double lastCallerTime = 0;
  bool clockStarted = false;
  uint64_t random = 0;
  uint64_t sequence = 0;
  std::atomic<bool> busy{false}, closed{false};
  std::vector<uint32_t> pulsesToClear;
};

// The rebound symbols. Outside a plugMain call (tCurrent null) each answers what the original
// would, so a plugin thread the host does not drive is not changed.
std::chrono::steady_clock::time_point hostSteadyNow() noexcept {
  if (!tCurrent) return std::chrono::steady_clock::now();
  const auto seconds = std::chrono::duration<double>(kClockBase + tCurrent->hostTime);
  return std::chrono::steady_clock::time_point(std::chrono::duration_cast<std::chrono::steady_clock::duration>(seconds));
}
int hostRand() {
  if (!tCurrent) return rand();
  return (int)(nextRandom(tCurrent->random) & RAND_MAX);
}
unsigned int hostRandomDevice(void *) {
  if (!tCurrent) { std::random_device device; return device(); }
  return nextRandom(tCurrent->random);
}

struct Rebinding { const char *symbol; void *replacement; int *count; bool *imported; };

// Rewrites the lazy and non-lazy symbol pointers of ONE loaded image (fishhook's technique,
// scoped). The image is the one that defines plugMain; no other image's pointers are visited.
void rebindImage(const void *symbolInImage, Rebinding *bindings, size_t count) {
  Dl_info info;
  if (!dladdr(symbolInImage, &info) || !info.dli_fbase) throw std::runtime_error("Cannot locate the plugin image");
  const auto header = static_cast<const mach_header_64 *>(info.dli_fbase);
  intptr_t slide = 0; bool found = false;
  for (uint32_t i = 0; i < _dyld_image_count(); i++)
    if (_dyld_get_image_header(i) == (const mach_header *)header) { slide = _dyld_get_image_vmaddr_slide(i); found = true; break; }
  if (!found || header->magic != MH_MAGIC_64) throw std::runtime_error("The plugin image is not a loaded 64-bit Mach-O");
  const segment_command_64 *linkedit = nullptr;
  const symtab_command *symtab = nullptr;
  const dysymtab_command *dysymtab = nullptr;
  std::vector<const section_64 *> pointerSections;
  auto command = reinterpret_cast<const load_command *>(header + 1);
  for (uint32_t i = 0; i < header->ncmds; i++, command = reinterpret_cast<const load_command *>((const char *)command + command->cmdsize)) {
    if (command->cmd == LC_SEGMENT_64) {
      auto segment = reinterpret_cast<const segment_command_64 *>(command);
      if (!strcmp(segment->segname, SEG_LINKEDIT)) linkedit = segment;
      if (strcmp(segment->segname, SEG_DATA) && strcmp(segment->segname, "__DATA_CONST")) continue;
      auto sections = reinterpret_cast<const section_64 *>(segment + 1);
      for (uint32_t s = 0; s < segment->nsects; s++) {
        const uint32_t type = sections[s].flags & SECTION_TYPE;
        if (type == S_LAZY_SYMBOL_POINTERS || type == S_NON_LAZY_SYMBOL_POINTERS) pointerSections.push_back(&sections[s]);
      }
    } else if (command->cmd == LC_SYMTAB) symtab = reinterpret_cast<const symtab_command *>(command);
    else if (command->cmd == LC_DYSYMTAB) dysymtab = reinterpret_cast<const dysymtab_command *>(command);
  }
  if (!linkedit || !symtab || !dysymtab || !dysymtab->nindirectsyms) throw std::runtime_error("The plugin image has no indirect symbol table");
  const uintptr_t base = (uintptr_t)slide + linkedit->vmaddr - linkedit->fileoff;
  const auto symbols = reinterpret_cast<const nlist_64 *>(base + symtab->symoff);
  const auto strings = reinterpret_cast<const char *>(base + symtab->stroff);
  const auto indirect = reinterpret_cast<const uint32_t *>(base + dysymtab->indirectsymoff);
  for (auto section : pointerSections) {
    const auto indices = indirect + section->reserved1;
    auto pointers = reinterpret_cast<void **>((uintptr_t)slide + section->addr);
    for (uint64_t i = 0; i < section->size / sizeof(void *); i++) {
      const uint32_t index = indices[i];
      if (index == INDIRECT_SYMBOL_ABS || index == INDIRECT_SYMBOL_LOCAL || index == (INDIRECT_SYMBOL_LOCAL | INDIRECT_SYMBOL_ABS)) continue;
      const char *name = strings + symbols[index].n_un.n_strx;
      for (size_t b = 0; b < count; b++) {
        if (strcmp(name, bindings[b].symbol)) continue;
        *bindings[b].imported = true;
        const vm_address_t page = (vm_address_t)&pointers[i] & ~(vm_address_t)(vm_page_size - 1);
        if (vm_protect(mach_task_self(), page, vm_page_size, false, VM_PROT_READ | VM_PROT_WRITE | VM_PROT_COPY) != KERN_SUCCESS) continue;
        pointers[i] = bindings[b].replacement;
        (*bindings[b].count)++;
        if (!strcmp(section->segname, "__DATA_CONST")) vm_protect(mach_task_self(), page, vm_page_size, false, VM_PROT_READ);
      }
    }
  }
}

struct Lease { std::shared_ptr<Instance> instance; size_t slot; };
struct State {
  std::mutex gl;  // every GL and plugMain call
  std::map<std::string, std::shared_ptr<Library>> libraries;
  std::map<std::string, std::shared_ptr<Instance>> instances;
  std::map<std::string, Lease> leases;
  uint64_t nextInstance = 0, nextLease = 0;
#ifdef LOOM_FFGL_STUDY
  std::map<IOSurfaceRef, bool> studySurfaces;
#endif
};

void check(napi_status status) { if (status != napi_ok) throw std::runtime_error("N-API call failed"); }
napi_value text(napi_env env, const std::string &value) { napi_value result; check(napi_create_string_utf8(env, value.c_str(), value.size(), &result)); return result; }
napi_value number(napi_env env, double value) { napi_value result; check(napi_create_double(env, value, &result)); return result; }
napi_value boolean(napi_env env, bool value) { napi_value result; check(napi_get_boolean(env, value, &result)); return result; }
void set(napi_env env, napi_value object, const char *key, napi_value value) { check(napi_set_named_property(env, object, key, value)); }
napi_value undefined(napi_env env) { napi_value result; napi_get_undefined(env, &result); return result; }
napi_value failure(napi_env env, const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
std::shared_ptr<State> &stateFor(napi_env env) {
  void *data = nullptr; check(napi_get_instance_data(env, &data));
  return *static_cast<std::shared_ptr<State> *>(data);
}
std::string stringArgument(napi_env env, napi_value value, const char *what) {
  size_t size = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok || size == 0 || size > 4096)
    throw std::runtime_error(std::string("Expected ") + what);
  std::string result(size, '\0');
  check(napi_get_value_string_utf8(env, value, result.data(), size + 1, &size));
  return result;
}
double numberArgument(napi_env env, napi_value value, const char *what) {
  double result;
  if (napi_get_value_double(env, value, &result) != napi_ok || !std::isfinite(result)) throw std::runtime_error(std::string("Expected finite ") + what);
  return result;
}
IOSurfaceRef surfaceArgument(napi_env env, napi_value value) {
  void *bytes = nullptr; size_t length = 0;
  if (napi_get_buffer_info(env, value, &bytes, &length) != napi_ok || length != sizeof(IOSurfaceRef))
    throw std::runtime_error("Expected a local IOSurfaceRef buffer");
  IOSurfaceRef surface; memcpy(&surface, bytes, sizeof(surface));
  if (!surface) throw std::runtime_error("Expected a non-null IOSurfaceRef");
  return surface;
}

// One plugMain call with the instance's time/random scope installed, and a C++ exception out
// of the plugin turned into an error the caller can see.
FFMixed call(Library &library, Instance *instance, FFUInt32 code, FFMixed input, const char *what) {
  Instance *previous = tCurrent; tCurrent = instance;
  try {
    FFMixed result = library.main(code, input, instance ? instance->ffInstance : nullptr);
    tCurrent = previous; return result;
  } catch (...) {
    tCurrent = previous;
    throw std::runtime_error(std::string("The plugin threw during ") + what);
  }
}
FFMixed none() { FFMixed value; value.PointerValue = nullptr; return value; }
FFMixed ffUInt(FFUInt32 value) { FFMixed result; result.PointerValue = nullptr; result.UIntValue = value; return result; }
FFMixed pointer(void *value) { FFMixed result; result.PointerValue = value; return result; }
float asFloat(FFMixed value) { float result; memcpy(&result, &value.UIntValue, sizeof(result)); return result; }
const char *asString(FFMixed value) { return value.PointerValue && value.UIntValue != FF_FAIL ? static_cast<const char *>(value.PointerValue) : ""; }

void glCheck(const char *what) {
  const GLenum error = glGetError();
  if (error != GL_NO_ERROR) {
    char message[96]; snprintf(message, sizeof(message), "GL error 0x%x %s", error, what);
    // Drain the queue so the next frame does not inherit this frame's errors.
    while (glGetError() != GL_NO_ERROR) {}
    throw std::runtime_error(message);
  }
}

CGLContextObj createContext() {
  CGLPixelFormatAttribute attributes[] = { kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_GL4_Core,
    kCGLPFAAccelerated, (CGLPixelFormatAttribute)0 };
  CGLPixelFormatObj format = nullptr; GLint formats = 0;
  if (CGLChoosePixelFormat(attributes, &format, &formats) != kCGLNoError || !format) throw std::runtime_error("No OpenGL 4.1 core pixel format");
  CGLContextObj context = nullptr;
  const CGLError created = CGLCreateContext(format, nullptr, &context);
  CGLDestroyPixelFormat(format);
  if (created != kCGLNoError || !context) throw std::runtime_error("Cannot create an OpenGL 4.1 core context");
  return context;
}
struct Current {
  explicit Current(CGLContextObj context) { if (CGLSetCurrentContext(context) != kCGLNoError) throw std::runtime_error("Cannot make the plugin context current"); }
  ~Current() { CGLSetCurrentContext(nullptr); }
};

// Loads (or re-references) a bundle binary, rebinds its clock/random symbols once, and runs
// FF_INITIALISE_V2. Caller holds the GL mutex.
std::shared_ptr<Library> acquireLibrary(State &state, const std::string &binary) {
  char resolved[PATH_MAX];
  if (!realpath(binary.c_str(), resolved)) throw std::runtime_error("FFGL plugin binary not found: " + binary);
  auto &entry = state.libraries[resolved];
  if (!entry) {
    auto library = std::make_shared<Library>();
    library->path = resolved;
    library->handle = dlopen(resolved, RTLD_NOW | RTLD_LOCAL);
    if (!library->handle) { state.libraries.erase(resolved); throw std::runtime_error(std::string("dlopen failed: ") + dlerror()); }
    library->main = (FFMain)dlsym(library->handle, "plugMain");
    if (!library->main) { dlclose(library->handle); state.libraries.erase(resolved); throw std::runtime_error("Not an FFGL plugin: no plugMain"); }
    Rebinding bindings[] = {
      { "__ZNSt3__16chrono12steady_clock3nowEv", (void *)&hostSteadyNow, &library->reboundClock, &library->importsClock },
      { "_rand", (void *)&hostRand, &library->reboundRand, &library->importsRand },
      { "__ZNSt3__113random_deviceclEv", (void *)&hostRandomDevice, &library->reboundRandomDevice, &library->importsRandomDevice },
    };
    // LOOM_FFGL_CLOCK=wallclock is the study's control arm: the binary runs exactly as it
    // does in Resolume, on its own clock, and reports so.
    const char *clock = getenv("LOOM_FFGL_CLOCK");
    if (clock && !strcmp(clock, "wallclock")) {
      library->importsClock = library->importsRand = library->importsRandomDevice = true;
    } else {
      try { rebindImage((const void *)library->main, bindings, 3); } catch (const std::exception &) { /* reported as wallclock */ }
    }
    entry = library;
  }
  auto library = entry;
  if (!library->initialised) {
    if (call(*library, nullptr, FF_INITIALISE_V2, none(), "FF_INITIALISE_V2").UIntValue != FF_SUCCESS) {
      if (library->references == 0) { state.libraries.erase(library->path); dlclose(library->handle); }
      throw std::runtime_error("FF_INITIALISE_V2 failed");
    }
    library->initialised = true;
  }
  library->references++;
  return library;
}
// Caller holds the GL mutex and has a context current.
void releaseLibrary(State &state, const std::shared_ptr<Library> &library) {
  if (--library->references > 0) return;
  if (library->initialised) { try { call(*library, nullptr, FF_DEINITIALISE, none(), "FF_DEINITIALISE"); } catch (...) {} }
  library->initialised = false;
  state.libraries.erase(library->path);
  // The library stays mapped: a C++ bundle's static destructors and any thread it started may
  // still reference its code, and Resolume does not unload either. Unloading is not a
  // correctness requirement for re-instantiation (FF_INITIALISE_V2 runs again).
}

std::string clockOf(const Library &library) {
  if (!library.importsClock) return "none";
  return library.reboundClock > 0 ? "host" : "wallclock";
}

// The plugin's own enumeration, read through plugMain only. Caller holds the GL mutex.
struct ParameterRecord {
  uint32_t index = 0, type = 0; std::string name, group, textDefault; float defaultValue = 0, min = 0, max = 1;
  bool visible = true, hasRange = false; std::vector<std::pair<std::string, float>> elements;
};
struct PluginRecord {
  std::string id, name, description, about; uint32_t type = 0, apiMajor = 0, apiMinor = 0, major = 0, minor = 0;
  bool setTime = false; uint32_t minInputs = 0, maxInputs = 0; std::vector<ParameterRecord> parameters;
};
PluginRecord describe(Library &library, Instance *instance) {
  PluginRecord record;
  auto info = static_cast<PluginInfoStruct *>(call(library, nullptr, FF_GET_INFO, none(), "FF_GET_INFO").PointerValue);
  if (!info) throw std::runtime_error("FF_GET_INFO returned nothing");
  record.id.assign(info->PluginUniqueID, strnlen(info->PluginUniqueID, 4));
  record.name.assign(info->PluginName, strnlen(info->PluginName, 16));
  record.type = info->PluginType; record.apiMajor = info->APIMajorVersion; record.apiMinor = info->APIMinorVersion;
  if (auto extended = static_cast<PluginExtendedInfoStruct *>(call(library, nullptr, FF_GET_EXTENDED_INFO, none(), "FF_GET_EXTENDED_INFO").PointerValue)) {
    record.major = extended->PluginMajorVersion; record.minor = extended->PluginMinorVersion;
    if (extended->Description) record.description = extended->Description;
    if (extended->About) record.about = extended->About;
  }
  record.setTime = call(library, nullptr, FF_GET_PLUGIN_CAPS, ffUInt(FF_CAP_SET_TIME), "FF_GET_PLUGIN_CAPS").UIntValue == 1;
  record.minInputs = call(library, nullptr, FF_GET_PLUGIN_CAPS, ffUInt(FF_CAP_MINIMUM_INPUT_FRAMES), "FF_GET_PLUGIN_CAPS").UIntValue;
  record.maxInputs = call(library, nullptr, FF_GET_PLUGIN_CAPS, ffUInt(FF_CAP_MAXIMUM_INPUT_FRAMES), "FF_GET_PLUGIN_CAPS").UIntValue;
  const uint32_t count = call(library, nullptr, FF_GET_NUM_PARAMETERS, none(), "FF_GET_NUM_PARAMETERS").UIntValue;
  if (count > 4096) throw std::runtime_error("Implausible FFGL parameter count");
  for (uint32_t i = 0; i < count; i++) {
    ParameterRecord parameter; parameter.index = i;
    parameter.name = asString(call(library, nullptr, FF_GET_PARAMETER_NAME, ffUInt(i), "FF_GET_PARAMETER_NAME"));
    parameter.type = call(library, nullptr, FF_GET_PARAMETER_TYPE, ffUInt(i), "FF_GET_PARAMETER_TYPE").UIntValue;
    const FFMixed defaultValue = call(library, nullptr, FF_GET_PARAMETER_DEFAULT, ffUInt(i), "FF_GET_PARAMETER_DEFAULT");
    if (parameter.type == FF_TYPE_TEXT || parameter.type == FF_TYPE_FILE) parameter.textDefault = asString(defaultValue);
    else parameter.defaultValue = asFloat(defaultValue);
    GetRangeStruct range{ i, { 0, 1 } };
    if (call(library, nullptr, FF_GET_RANGE, pointer(&range), "FF_GET_RANGE").UIntValue == FF_SUCCESS) {
      parameter.min = range.range.min; parameter.max = range.range.max; parameter.hasRange = true;
    }
    char group[256] = {};
    GetStringStruct groupQuery{ i, { group, sizeof(group) - 1 } };
    if (call(library, nullptr, FF_GET_PARAM_GROUP, pointer(&groupQuery), "FF_GET_PARAM_GROUP").UIntValue == FF_SUCCESS) parameter.group = group;
    parameter.visible = call(library, instance, FF_GET_PRAMETER_VISIBILITY, ffUInt(i), "FF_GET_PRAMETER_VISIBILITY").UIntValue != 0;
    // The SDK answers one unnamed element for every parameter; only an option's are a menu.
    const uint32_t elements = parameter.type == FF_TYPE_OPTION
      ? call(library, instance, FF_GET_NUM_PARAMETER_ELEMENTS, ffUInt(i), "FF_GET_NUM_PARAMETER_ELEMENTS").UIntValue : 0;
    if (elements != FF_FAIL && elements <= 4096) {
      for (uint32_t e = 0; e < elements; e++) {
        GetParameterElementStruct query{ i, e };
        std::string name = asString(call(library, instance, FF_GET_PARAMETER_ELEMENT_NAME, pointer(&query), "FF_GET_PARAMETER_ELEMENT_NAME"));
        const float value = asFloat(call(library, instance, FF_GET_PARAMETER_ELEMENT_VALUE, pointer(&query), "FF_GET_PARAMETER_ELEMENT_VALUE"));
        parameter.elements.emplace_back(name, value);
      }
    }
    record.parameters.push_back(std::move(parameter));
  }
  return record;
}

napi_value toJs(napi_env env, const PluginRecord &record, const Library &library) {
  napi_value result, parameters;
  check(napi_create_object(env, &result));
  set(env, result, "id", text(env, record.id));
  set(env, result, "name", text(env, record.name));
  set(env, result, "pluginType", number(env, record.type));
  set(env, result, "apiVersion", text(env, std::to_string(record.apiMajor) + "." + std::to_string(record.apiMinor)));
  set(env, result, "version", text(env, std::to_string(record.major) + "." + std::to_string(record.minor)));
  set(env, result, "description", text(env, record.description));
  set(env, result, "about", text(env, record.about));
  set(env, result, "supportsSetTime", boolean(env, record.setTime));
  set(env, result, "minInputs", number(env, record.minInputs));
  set(env, result, "maxInputs", number(env, record.maxInputs));
  set(env, result, "binary", text(env, library.path));
  napi_value clock; check(napi_create_object(env, &clock));
  set(env, clock, "mode", text(env, clockOf(library)));
  set(env, clock, "steadyClock", number(env, library.reboundClock));
  set(env, clock, "rand", number(env, library.reboundRand));
  set(env, clock, "randomDevice", number(env, library.reboundRandomDevice));
  set(env, result, "clock", clock);
  check(napi_create_array_with_length(env, record.parameters.size(), &parameters));
  for (size_t i = 0; i < record.parameters.size(); i++) {
    const auto &parameter = record.parameters[i];
    napi_value entry, elements, range;
    check(napi_create_object(env, &entry));
    set(env, entry, "index", number(env, parameter.index));
    set(env, entry, "name", text(env, parameter.name));
    set(env, entry, "type", number(env, parameter.type));
    set(env, entry, "default", parameter.type == FF_TYPE_TEXT || parameter.type == FF_TYPE_FILE
      ? text(env, parameter.textDefault) : number(env, parameter.defaultValue));
    check(napi_create_object(env, &range));
    set(env, range, "min", number(env, parameter.min)); set(env, range, "max", number(env, parameter.max));
    set(env, entry, "range", range);
    set(env, entry, "group", text(env, parameter.group));
    set(env, entry, "visible", boolean(env, parameter.visible));
    check(napi_create_array_with_length(env, parameter.elements.size(), &elements));
    for (size_t e = 0; e < parameter.elements.size(); e++) {
      napi_value element; check(napi_create_object(env, &element));
      set(env, element, "name", text(env, parameter.elements[e].first));
      set(env, element, "value", number(env, parameter.elements[e].second));
      check(napi_set_element(env, elements, e, element));
    }
    set(env, entry, "elements", elements);
    check(napi_set_element(env, parameters, i, entry));
  }
  set(env, result, "parameters", parameters);
  return result;
}

// ---- GL resources ---------------------------------------------------------------------------
const char *kVertex = "#version 410 core\n"
  "void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));\n"
  "  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }\n";
// Exact copy with a row flip: texel (x, h-1-y). No filtering, so bytes survive unchanged.
const char *kFragment = "#version 410 core\n"
  "uniform sampler2DRect source; uniform ivec2 size; out vec4 color;\n"
  "void main() { ivec2 p = ivec2(gl_FragCoord.xy); color = texelFetch(source, ivec2(p.x, size.y - 1 - p.y)); }\n";
GLuint compile(GLenum kind, const char *source) {
  GLuint shader = glCreateShader(kind);
  glShaderSource(shader, 1, &source, nullptr); glCompileShader(shader);
  GLint ok = 0; glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
  if (!ok) { char log[512] = {}; glGetShaderInfoLog(shader, sizeof(log), nullptr, log); glDeleteShader(shader);
    throw std::runtime_error(std::string("Host blit shader failed: ") + log); }
  return shader;
}
IOSurfaceRef createSurface(uint32_t width, uint32_t height) {
  IOSurfaceRef surface = IOSurfaceCreate((__bridge CFDictionaryRef)@{
    (NSString *)kIOSurfaceWidth: @(width), (NSString *)kIOSurfaceHeight: @(height),
    (NSString *)kIOSurfaceBytesPerElement: @4, (NSString *)kIOSurfacePixelFormat: @(kBGRA) });
  if (!surface) throw std::runtime_error("Cannot allocate an FFGL output IOSurface");
  return surface;
}
void bindSurface(CGLContextObj context, GLuint texture, IOSurfaceRef surface) {
  glBindTexture(GL_TEXTURE_RECTANGLE, texture);
  const CGLError error = CGLTexImageIOSurface2D(context, GL_TEXTURE_RECTANGLE, GL_RGBA8,
    (GLsizei)IOSurfaceGetWidth(surface), (GLsizei)IOSurfaceGetHeight(surface), GL_BGRA, GL_UNSIGNED_INT_8_8_8_8_REV, surface, 0);
  glTexParameteri(GL_TEXTURE_RECTANGLE, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_RECTANGLE, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  glBindTexture(GL_TEXTURE_RECTANGLE, 0);
  if (error != kCGLNoError) throw std::runtime_error("Cannot bind an IOSurface to an OpenGL texture");
}
void createResources(Instance &instance) {
  glGenTextures(1, &instance.inputRect);
  glGenTextures(1, &instance.input2D);
  glBindTexture(GL_TEXTURE_2D, instance.input2D);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, instance.width, instance.height, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glBindTexture(GL_TEXTURE_2D, 0);
  glGenFramebuffers(1, &instance.inputFramebuffer);
  glBindFramebuffer(GL_FRAMEBUFFER, instance.inputFramebuffer);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, instance.input2D, 0);
  if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) throw std::runtime_error("FFGL input framebuffer incomplete");
  for (auto &slot : instance.slots) {
    slot.surface = createSurface(instance.width, instance.height);
    glGenTextures(1, &slot.texture);
    bindSurface(instance.context, slot.texture, slot.surface);
    glGenFramebuffers(1, &slot.framebuffer);
    glBindFramebuffer(GL_FRAMEBUFFER, slot.framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_RECTANGLE, slot.texture, 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) throw std::runtime_error("FFGL output framebuffer incomplete");
  }
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  const GLuint vertex = compile(GL_VERTEX_SHADER, kVertex), fragment = compile(GL_FRAGMENT_SHADER, kFragment);
  instance.program = glCreateProgram();
  glAttachShader(instance.program, vertex); glAttachShader(instance.program, fragment);
  glLinkProgram(instance.program); glDeleteShader(vertex); glDeleteShader(fragment);
  GLint linked = 0; glGetProgramiv(instance.program, GL_LINK_STATUS, &linked);
  if (!linked) throw std::runtime_error("Host blit program failed to link");
  instance.sizeLocation = glGetUniformLocation(instance.program, "size");
  glGenVertexArrays(1, &instance.vertexArray);
  glGenQueries(1, &instance.timer);
  glCheck("creating host resources");
}
void destroyResources(Instance &instance) {
  for (auto &slot : instance.slots) {
    if (slot.framebuffer) glDeleteFramebuffers(1, &slot.framebuffer);
    if (slot.texture) glDeleteTextures(1, &slot.texture);
    // A leased surface is still being read by the page: its lease now owns it, and
    // release() frees it. An unleased one goes now.
    std::lock_guard<std::mutex> lock(leaseMutex);
    slot.framebuffer = 0; slot.texture = 0;
    if (slot.lease.empty() && slot.surface) { CFRelease(slot.surface); slot.surface = nullptr; }
  }
  if (instance.inputFramebuffer) glDeleteFramebuffers(1, &instance.inputFramebuffer);
  if (instance.input2D) glDeleteTextures(1, &instance.input2D);
  if (instance.inputRect) glDeleteTextures(1, &instance.inputRect);
  if (instance.program) glDeleteProgram(instance.program);
  if (instance.vertexArray) glDeleteVertexArrays(1, &instance.vertexArray);
  if (instance.timer) glDeleteQueries(1, &instance.timer);
}

// ---- Async jobs ----------------------------------------------------------------------------
struct Job {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::shared_ptr<State> state;
  std::string error;
  virtual ~Job() = default;
  virtual void run() = 0;
  virtual napi_value result(napi_env env) = 0;
};
void executeJob(napi_env, void *data) {
  auto job = static_cast<Job *>(data);
  @autoreleasepool {
    try { std::lock_guard<std::mutex> lock(job->state->gl); job->run(); }
    catch (const std::exception &error) { job->error = error.what(); }
    catch (...) { job->error = "Unknown native FFGL failure"; }
  }
}
void completeJob(napi_env env, napi_status status, void *data) {
  std::unique_ptr<Job> job(static_cast<Job *>(data));
  napi_value value = nullptr;
  if (status != napi_ok && job->error.empty()) job->error = "Native FFGL job cancelled";
  if (job->error.empty()) {
    try { value = job->result(env); } catch (const std::exception &error) { job->error = error.what(); }
  }
  if (job->error.empty()) napi_resolve_deferred(env, job->deferred, value);
  else {
    napi_value message, error;
    napi_create_string_utf8(env, job->error.c_str(), NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &error);
    napi_reject_deferred(env, job->deferred, error);
  }
  napi_delete_async_work(env, job->work);
}
napi_value queue(napi_env env, std::unique_ptr<Job> job, const char *name) {
  napi_value promise;
  check(napi_create_promise(env, &job->deferred, &promise));
  check(napi_create_async_work(env, nullptr, text(env, name), executeJob, completeJob, job.get(), &job->work));
  const napi_status queued = napi_queue_async_work(env, job->work);
  if (queued != napi_ok) { napi_delete_async_work(env, job->work); check(queued); }
  job.release();
  return promise;
}

double nowMs() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

// probe(binary) → the plugin's info and parameter table, with no GL instance.
struct ProbeJob : Job {
  std::string binary; PluginRecord record; std::shared_ptr<Library> library; double loadMs = 0;
  void run() override {
    const double start = nowMs();
    CGLContextObj context = createContext();
    try {
      Current current(context);
      library = acquireLibrary(*state, binary);
      try { record = describe(*library, nullptr); } catch (...) { releaseLibrary(*state, library); throw; }
      releaseLibrary(*state, library);
    } catch (...) { CGLDestroyContext(context); throw; }
    CGLDestroyContext(context);
    loadMs = nowMs() - start;
  }
  napi_value result(napi_env env) override {
    napi_value value = toJs(env, record, *library);
    set(env, value, "loadMs", number(env, loadMs));
    return value;
  }
};

// open(binary, width, height, seed) → an instance id plus its table, measured load time.
struct OpenJob : Job {
  std::string binary, id; uint32_t width = 0, height = 0; uint64_t seed = 0;
  std::shared_ptr<Instance> instance; PluginRecord record; double loadMs = 0;
  void run() override {
    const double start = nowMs();
    instance = std::make_shared<Instance>();
    instance->width = width; instance->height = height; instance->random = seed;
    instance->context = createContext();
    try {
      Current current(instance->context);
      instance->library = acquireLibrary(*state, binary);
      try {
        createResources(*instance);
        FFGLViewportStruct viewport{ 0, 0, width, height };
        // Constructed inside the instance's time scope: ffglqs's t_start reads the rebound
        // clock at frame time 0, so `timeNow` later equals the time the caller passes.
        const FFMixed created = call(*instance->library, instance.get(), FF_INSTANTIATE_GL, pointer(&viewport), "FF_INSTANTIATE_GL");
        if (created.UIntValue == FF_FAIL || !created.PointerValue) throw std::runtime_error("FF_INSTANTIATE_GL failed (shader compile?)");
        instance->ffInstance = created.PointerValue;
        SetHostinfoStruct host{ "Loom", "VN85" };
        call(*instance->library, instance.get(), FF_SET_HOSTINFO, pointer(&host), "FF_SET_HOSTINFO");
        glCheck("after FF_INSTANTIATE_GL");
        record = describe(*instance->library, instance.get());
      } catch (...) {
        if (instance->ffInstance) { try { call(*instance->library, instance.get(), FF_DEINSTANTIATE_GL, none(), "FF_DEINSTANTIATE_GL"); } catch (...) {} }
        destroyResources(*instance);
        releaseLibrary(*state, instance->library);
        throw;
      }
    } catch (...) { CGLDestroyContext(instance->context); instance->context = nullptr; throw; }
    id = "ffgl-instance-" + std::to_string(++state->nextInstance);
    state->instances[id] = instance;
    loadMs = nowMs() - start;
  }
  napi_value result(napi_env env) override {
    napi_value value = toJs(env, record, *instance->library);
    set(env, value, "instance", text(env, id));
    set(env, value, "width", number(env, width));
    set(env, value, "height", number(env, height));
    set(env, value, "loadMs", number(env, loadMs));
    return value;
  }
};

void pluginClock(Instance &instance, double time, double interval, bool reset) {
  if (reset || !instance.clockStarted) {
    instance.hostTime = std::max(0.0, time);
    instance.clockStarted = true;
  } else {
    const double step = time - instance.lastCallerTime;
    if (step > 0 && step <= 8 * interval) instance.hostTime += step;
    else if (step != 0) instance.hostTime += interval;
  }
  instance.lastCallerTime = time;
}

struct ParameterWrite { uint32_t index; bool isText; float value; std::string textValue; };

// process(instance, inputSurface, frame) → an output surface lease. One per instance at a time.
struct ProcessJob : Job {
  std::shared_ptr<Instance> instance; IOSurfaceRef input = nullptr;
  double time = 0, bpm = 120, barPhase = 0, interval = 1.0 / 60.0;
  bool reset = false;
  std::vector<ParameterWrite> writes; std::vector<uint32_t> pulses;
  size_t slot = 0; std::string lease; uint64_t sequence = 0;
  double cpuMs = 0, gpuMs = -1, blitMs = 0;
  // Runs on the JS thread when the job settles, success or failure.
  ~ProcessJob() override { if (input) CFRelease(input); if (instance) instance->busy = false; }
  void run() override {
    if (instance->closed) throw std::runtime_error("FFGL instance closed before processing");
    const double start = nowMs();
    Current current(instance->context);
    auto &library = *instance->library;
    if (IOSurfaceGetWidth(input) != instance->width || IOSurfaceGetHeight(input) != instance->height)
      throw std::runtime_error("FFGL input surface size does not match the instance");
    const uint32_t fourcc = IOSurfaceGetPixelFormat(input);
    if ((fourcc != kBGRA && fourcc != 0) || IOSurfaceGetBytesPerElement(input) != 4 || IOSurfaceGetPlaneCount(input) != 0)
      throw std::runtime_error("FFGL input IOSurface is not packed BGRA8");
    // Pick a free output surface; a leased one is still being read by the page.
    bool free = false;
    {
      std::lock_guard<std::mutex> lock(leaseMutex);
      for (size_t i = 0; i < kOutputSlots; i++) if (instance->slots[i].lease.empty()) { slot = i; free = true; break; }
    }
    if (!free) throw std::runtime_error("Every FFGL output surface is still leased");
    // Hop 1: the input surface, row-flipped into the GL_TEXTURE_2D a plugin samples.
    bindSurface(instance->context, instance->inputRect, input);
    glBindFramebuffer(GL_FRAMEBUFFER, instance->inputFramebuffer);
    glViewport(0, 0, instance->width, instance->height);
    glUseProgram(instance->program);
    glUniform2i(instance->sizeLocation, (GLint)instance->width, (GLint)instance->height);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_RECTANGLE, instance->inputRect);
    glBindVertexArray(instance->vertexArray);
    glDisable(GL_BLEND);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    glBindVertexArray(0); glBindTexture(GL_TEXTURE_RECTANGLE, 0); glUseProgram(0);
    glCheck("in the input blit");
    blitMs = nowMs() - start;
    // Parameters, pulses, time and beat, then the plugin.
    pluginClock(*instance, time, interval, reset);
    const uint32_t count = call(library, nullptr, FF_GET_NUM_PARAMETERS, none(), "FF_GET_NUM_PARAMETERS").UIntValue;
    auto write = [&](uint32_t index, float value) {
      SetParameterStruct parameter{ index, ffUInt(0) }; memcpy(&parameter.NewParameterValue.UIntValue, &value, sizeof(value));
      if (call(library, instance.get(), FF_SET_PARAMETER, pointer(&parameter), "FF_SET_PARAMETER").UIntValue != FF_SUCCESS)
        throw std::runtime_error("FF_SET_PARAMETER refused index " + std::to_string(index));
    };
    // A pulse raised last frame falls back to 0 before this frame's writes (Resolume's event).
    for (uint32_t index : instance->pulsesToClear) write(index, 0.0f);
    instance->pulsesToClear.clear();
    for (auto &entry : writes) {
      if (entry.index >= count) throw std::runtime_error("No FFGL parameter at index " + std::to_string(entry.index));
      if (entry.isText) {
        SetParameterStruct parameter{ entry.index, pointer((void *)entry.textValue.c_str()) };
        if (call(library, instance.get(), FF_SET_PARAMETER, pointer(&parameter), "FF_SET_PARAMETER").UIntValue != FF_SUCCESS)
          throw std::runtime_error("FF_SET_PARAMETER refused text index " + std::to_string(entry.index));
      } else write(entry.index, entry.value);
    }
    for (uint32_t index : pulses) {
      if (index >= count) throw std::runtime_error("No FFGL parameter at index " + std::to_string(index));
      if (call(library, nullptr, FF_GET_PARAMETER_TYPE, ffUInt(index), "FF_GET_PARAMETER_TYPE").UIntValue != FF_TYPE_EVENT)
        throw std::runtime_error("FFGL parameter " + std::to_string(index) + " is not an event");
      write(index, 1.0f); instance->pulsesToClear.push_back(index);
    }
    double hostTime = time;
    call(library, instance.get(), FF_SET_TIME, pointer(&hostTime), "FF_SET_TIME");
    SetBeatinfoStruct beat{ (float)bpm, (float)barPhase };
    call(library, instance.get(), FF_SET_BEATINFO, pointer(&beat), "FF_SET_BEATINFO");
    auto &target = instance->slots[slot];
    glBindFramebuffer(GL_FRAMEBUFFER, target.framebuffer);
    glViewport(0, 0, instance->width, instance->height);
    glClearColor(0, 0, 0, 0); glClear(GL_COLOR_BUFFER_BIT);
    glCheck("before FF_PROCESS_OPENGL");
    FFGLTextureStruct texture{ instance->width, instance->height, instance->width, instance->height, instance->input2D };
    FFGLTextureStruct *textures[1] = { &texture };
    ProcessOpenGLStruct process{ 1, textures, target.framebuffer };
    glBeginQuery(GL_TIME_ELAPSED, instance->timer);
    const FFUInt32 processed = call(library, instance.get(), FF_PROCESS_OPENGL, pointer(&process), "FF_PROCESS_OPENGL").UIntValue;
    glEndQuery(GL_TIME_ELAPSED);
    if (processed != FF_SUCCESS) { glFinish(); throw std::runtime_error("FF_PROCESS_OPENGL failed"); }
    glCheck("after FF_PROCESS_OPENGL");
    // The page's GPU reads this surface next: every GL write must be complete, not queued.
    glFinish();
    GLuint64 elapsed = 0; glGetQueryObjectui64v(instance->timer, GL_QUERY_RESULT, &elapsed);
    gpuMs = elapsed / 1e6;
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    {
      std::lock_guard<std::mutex> lock(leaseMutex);
      lease = "ffgl-lease-" + std::to_string(++state->nextLease);
      target.lease = lease;
      state->leases[lease] = Lease{ instance, slot };
    }
    sequence = ++instance->sequence;
    cpuMs = nowMs() - start;
  }
  napi_value result(napi_env env) override {
    napi_value value, handle;
    check(napi_create_object(env, &value));
    IOSurfaceRef surface = instance->slots[slot].surface;
    check(napi_create_buffer_copy(env, sizeof(IOSurfaceRef), &surface, nullptr, &handle));
    set(env, value, "handle", handle);
    set(env, value, "leaseId", text(env, lease));
    set(env, value, "width", number(env, instance->width));
    set(env, value, "height", number(env, instance->height));
    set(env, value, "sequence", number(env, (double)sequence));
    set(env, value, "bottomUp", boolean(env, true));
    set(env, value, "clock", number(env, instance->hostTime));
    napi_value timing; check(napi_create_object(env, &timing));
    set(env, timing, "cpuMs", number(env, cpuMs));
    set(env, timing, "gpuMs", number(env, gpuMs));
    set(env, timing, "blitMs", number(env, blitMs));
    set(env, value, "timing", timing);
    return value;
  }
};

// Reads one parameter back through FF_GET_PARAMETER.
struct ReadJob : Job {
  std::shared_ptr<Instance> instance; uint32_t index = 0; bool isText = false; float value = 0; std::string textValue;
  void run() override {
    if (instance->closed) throw std::runtime_error("FFGL instance is closed");
    Current current(instance->context);
    auto &library = *instance->library;
    const uint32_t count = call(library, nullptr, FF_GET_NUM_PARAMETERS, none(), "FF_GET_NUM_PARAMETERS").UIntValue;
    if (index >= count) throw std::runtime_error("No FFGL parameter at index " + std::to_string(index));
    const uint32_t type = call(library, nullptr, FF_GET_PARAMETER_TYPE, ffUInt(index), "FF_GET_PARAMETER_TYPE").UIntValue;
    const FFMixed read = call(library, instance.get(), FF_GET_PARAMETER, ffUInt(index), "FF_GET_PARAMETER");
    isText = type == FF_TYPE_TEXT || type == FF_TYPE_FILE;
    if (isText) textValue = asString(read); else value = asFloat(read);
  }
  napi_value result(napi_env env) override { return isText ? text(env, textValue) : number(env, value); }
};

struct CloseJob : Job {
  std::shared_ptr<Instance> instance;
  void run() override {
    {
      Current current(instance->context);
      std::string failure;
      try { call(*instance->library, instance.get(), FF_DEINSTANTIATE_GL, none(), "FF_DEINSTANTIATE_GL"); }
      catch (const std::exception &error) { failure = error.what(); }
      instance->ffInstance = nullptr;
      destroyResources(*instance);
      releaseLibrary(*state, instance->library);
      if (!failure.empty()) throw std::runtime_error(failure);
    }
    CGLDestroyContext(instance->context); instance->context = nullptr;
  }
  napi_value result(napi_env env) override { return undefined(env); }
};

std::shared_ptr<Instance> instanceFor(State &state, napi_env env, napi_value value) {
  const std::string id = stringArgument(env, value, "an FFGL instance id");
  auto found = state.instances.find(id);
  if (found == state.instances.end()) throw std::runtime_error("Unknown FFGL instance " + id);
  return found->second;
}
napi_value arguments(napi_env env, napi_callback_info info, size_t expected, napi_value *argv, size_t optional = 0) {
  size_t argc = expected;
  check(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (argc < expected - optional || argc > expected) throw std::runtime_error("Wrong number of arguments");
  for (size_t i = argc; i < expected; i++) argv[i] = undefined(env);
  return nullptr;
}
bool isUndefined(napi_env env, napi_value value) { napi_valuetype type; napi_typeof(env, value, &type); return type == napi_undefined || type == napi_null; }
napi_value property(napi_env env, napi_value object, const char *key) { napi_value value; check(napi_get_named_property(env, object, key, &value)); return value; }

napi_value probe(napi_env env, napi_callback_info info) {
  try {
    napi_value argv[1]; arguments(env, info, 1, argv);
    auto job = std::make_unique<ProbeJob>();
    job->state = stateFor(env); job->binary = stringArgument(env, argv[0], "a plugin binary path");
    return queue(env, std::move(job), "FFGL probe");
  } catch (const std::exception &error) { return failure(env, error); }
}
napi_value open(napi_env env, napi_callback_info info) {
  try {
    napi_value argv[4]; arguments(env, info, 4, argv, 1);
    auto job = std::make_unique<OpenJob>();
    job->state = stateFor(env); job->binary = stringArgument(env, argv[0], "a plugin binary path");
    const double width = numberArgument(env, argv[1], "width"), height = numberArgument(env, argv[2], "height");
    if (width < 1 || height < 1 || width > 16384 || height > 16384 || width != std::floor(width) || height != std::floor(height))
      throw std::runtime_error("FFGL instance size must be whole pixels in 1..16384");
    job->width = (uint32_t)width; job->height = (uint32_t)height;
    job->seed = isUndefined(env, argv[3]) ? 0 : (uint64_t)numberArgument(env, argv[3], "seed");
    return queue(env, std::move(job), "FFGL open");
  } catch (const std::exception &error) { return failure(env, error); }
}
// process(instance, surface, { time, bpm, barPhase, parameters: [[index, value]], pulses: [index] })
napi_value process(napi_env env, napi_callback_info info) {
  try {
    napi_value argv[3]; arguments(env, info, 3, argv);
    auto &state = stateFor(env);
    auto instance = instanceFor(*state, env, argv[0]);
    if (instance->busy) throw std::runtime_error("FFGL instance is already processing a frame");
    if (instance->closed) throw std::runtime_error("FFGL instance is closed");
    auto job = std::make_unique<ProcessJob>();
    job->state = state; job->instance = instance;
    IOSurfaceRef surface = surfaceArgument(env, argv[1]);
    job->time = numberArgument(env, property(env, argv[2], "time"), "time");
    job->bpm = numberArgument(env, property(env, argv[2], "bpm"), "bpm");
    job->barPhase = numberArgument(env, property(env, argv[2], "barPhase"), "barPhase");
    napi_value interval = property(env, argv[2], "interval"), reset = property(env, argv[2], "reset");
    if (!isUndefined(env, interval)) {
      job->interval = numberArgument(env, interval, "interval");
      if (job->interval <= 0 || job->interval > 1) throw std::runtime_error("FFGL frame interval must be in (0, 1] seconds");
    }
    if (!isUndefined(env, reset)) check(napi_get_value_bool(env, reset, &job->reset));
    napi_value writes = property(env, argv[2], "parameters");
    if (!isUndefined(env, writes)) {
      uint32_t length = 0; check(napi_get_array_length(env, writes, &length));
      for (uint32_t i = 0; i < length; i++) {
        napi_value pair, index, value; check(napi_get_element(env, writes, i, &pair));
        check(napi_get_element(env, pair, 0, &index)); check(napi_get_element(env, pair, 1, &value));
        ParameterWrite write{};
        const double position = numberArgument(env, index, "parameter index");
        if (position < 0 || position != std::floor(position)) throw std::runtime_error("Parameter index must be a whole number");
        write.index = (uint32_t)position;
        napi_valuetype type; check(napi_typeof(env, value, &type));
        if (type == napi_string) { write.isText = true; write.textValue = stringArgument(env, value, "a text parameter"); }
        else if (type == napi_boolean) { bool flag; check(napi_get_value_bool(env, value, &flag)); write.value = flag ? 1.0f : 0.0f; }
        else write.value = (float)numberArgument(env, value, "parameter value");
        job->writes.push_back(write);
      }
    }
    napi_value pulses = property(env, argv[2], "pulses");
    if (!isUndefined(env, pulses)) {
      uint32_t length = 0; check(napi_get_array_length(env, pulses, &length));
      for (uint32_t i = 0; i < length; i++) {
        napi_value index; check(napi_get_element(env, pulses, i, &index));
        const double position = numberArgument(env, index, "pulse index");
        if (position < 0 || position != std::floor(position)) throw std::runtime_error("Pulse index must be a whole number");
        job->pulses.push_back((uint32_t)position);
      }
    }
    job->input = (IOSurfaceRef)CFRetain(surface);
    instance->busy = true;
    try { return queue(env, std::move(job), "FFGL process"); }
    catch (...) { instance->busy = false; throw; }
  } catch (const std::exception &error) { return failure(env, error); }
}
napi_value parameter(napi_env env, napi_callback_info info) {
  try {
    napi_value argv[2]; arguments(env, info, 2, argv);
    auto &state = stateFor(env);
    auto job = std::make_unique<ReadJob>();
    job->state = state; job->instance = instanceFor(*state, env, argv[0]);
    const double index = numberArgument(env, argv[1], "parameter index");
    if (index < 0 || index != std::floor(index)) throw std::runtime_error("Parameter index must be a whole number");
    job->index = (uint32_t)index;
    return queue(env, std::move(job), "FFGL parameter");
  } catch (const std::exception &error) { return failure(env, error); }
}
napi_value release(napi_env env, napi_callback_info info) {
  try {
    napi_value argv[1]; arguments(env, info, 1, argv);
    auto &state = stateFor(env);
    const std::string id = stringArgument(env, argv[0], "an FFGL lease id");
    std::lock_guard<std::mutex> lock(leaseMutex);
    auto found = state->leases.find(id);
    if (found == state->leases.end()) throw std::runtime_error("Unknown or already released FFGL lease");
    auto &slot = found->second.instance->slots[found->second.slot];
    // After close, the slot's GL objects are gone and the lease alone owns the surface.
    if (found->second.instance->closed && !slot.texture && slot.surface) { CFRelease(slot.surface); slot.surface = nullptr; }
    slot.lease.clear();
    state->leases.erase(found);
    return undefined(env);
  } catch (const std::exception &error) { return failure(env, error); }
}
napi_value close(napi_env env, napi_callback_info info) {
  try {
    napi_value argv[1]; arguments(env, info, 1, argv);
    auto &state = stateFor(env);
    auto instance = instanceFor(*state, env, argv[0]);
    if (instance->busy) throw std::runtime_error("FFGL instance is processing; close after the frame settles");
    instance->closed = true;
    state->instances.erase(stringArgument(env, argv[0], "an FFGL instance id"));
    auto job = std::make_unique<CloseJob>();
    job->state = state; job->instance = instance;
    return queue(env, std::move(job), "FFGL close");
  } catch (const std::exception &error) { return failure(env, error); }
}
napi_value diagnostics(napi_env env, napi_callback_info) {
  try {
    auto &state = stateFor(env);
    napi_value value; check(napi_create_object(env, &value));
    set(env, value, "instances", number(env, state->instances.size()));
    set(env, value, "libraries", number(env, state->libraries.size()));
    set(env, value, "leases", number(env, state->leases.size()));
    struct rusage usage; getrusage(RUSAGE_SELF, &usage);
    set(env, value, "maxRssBytes", number(env, (double)usage.ru_maxrss));
    return value;
  } catch (const std::exception &error) { return failure(env, error); }
}

#ifdef LOOM_FFGL_STUDY
// Study/test only (never in the product addon): make a BGRA surface from RGBA bytes laid out
// top row first, as a Chromium capture is, and read any surface's bytes back as RGBA in memory
// row order. These are the harness's oracle, not a Loom readback path.
napi_value createStudySurface(napi_env env, napi_callback_info info) {
  try {
    napi_value argv[3]; arguments(env, info, 3, argv);
    const double width = numberArgument(env, argv[0], "width"), height = numberArgument(env, argv[1], "height");
    if (width < 1 || height < 1 || width > 16384 || height > 16384) throw std::runtime_error("Bad study surface size");
    void *bytes = nullptr; size_t length = 0;
    if (napi_get_buffer_info(env, argv[2], &bytes, &length) != napi_ok || length != (size_t)width * (size_t)height * 4)
      throw std::runtime_error("Study surface bytes must be width*height*4 RGBA");
    IOSurfaceRef surface = createSurface((uint32_t)width, (uint32_t)height);
    IOSurfaceLock(surface, 0, nullptr);
    auto base = static_cast<uint8_t *>(IOSurfaceGetBaseAddress(surface));
    const size_t stride = IOSurfaceGetBytesPerRow(surface);
    auto source = static_cast<const uint8_t *>(bytes);
    for (size_t y = 0; y < (size_t)height; y++)
      for (size_t x = 0; x < (size_t)width; x++) {
        const uint8_t *from = source + (y * (size_t)width + x) * 4; uint8_t *to = base + y * stride + x * 4;
        to[0] = from[2]; to[1] = from[1]; to[2] = from[0]; to[3] = from[3];
      }
    IOSurfaceUnlock(surface, 0, nullptr);
    stateFor(env)->studySurfaces[surface] = true;
    napi_value handle; check(napi_create_buffer_copy(env, sizeof(IOSurfaceRef), &surface, nullptr, &handle));
    return handle;
  } catch (const std::exception &error) { return failure(env, error); }
}
napi_value readStudySurface(napi_env env, napi_callback_info info) {
  try {
    napi_value argv[1]; arguments(env, info, 1, argv);
    IOSurfaceRef surface = surfaceArgument(env, argv[0]);
    const size_t width = IOSurfaceGetWidth(surface), height = IOSurfaceGetHeight(surface), stride = IOSurfaceGetBytesPerRow(surface);
    void *data = nullptr; napi_value result;
    check(napi_create_buffer(env, width * height * 4, &data, &result));
    IOSurfaceLock(surface, kIOSurfaceLockReadOnly, nullptr);
    auto base = static_cast<const uint8_t *>(IOSurfaceGetBaseAddress(surface));
    auto target = static_cast<uint8_t *>(data);
    for (size_t y = 0; y < height; y++)
      for (size_t x = 0; x < width; x++) {
        const uint8_t *from = base + y * stride + x * 4; uint8_t *to = target + (y * width + x) * 4;
        to[0] = from[2]; to[1] = from[1]; to[2] = from[0]; to[3] = from[3];
      }
    IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, nullptr);
    return result;
  } catch (const std::exception &error) { return failure(env, error); }
}
napi_value destroyStudySurface(napi_env env, napi_callback_info info) {
  try {
    napi_value argv[1]; arguments(env, info, 1, argv);
    IOSurfaceRef surface = surfaceArgument(env, argv[0]);
    auto &owned = stateFor(env)->studySurfaces;
    if (!owned.erase(surface)) throw std::runtime_error("Not a study surface made by this addon");
    CFRelease(surface);
    return undefined(env);
  } catch (const std::exception &error) { return failure(env, error); }
}
#endif

void finalize(napi_env, void *data, void *) { delete static_cast<std::shared_ptr<State> *>(data); }
} // namespace

NAPI_MODULE_INIT() {
  try {
    check(napi_set_instance_data(env, new std::shared_ptr<State>(std::make_shared<State>()), finalize, nullptr));
    napi_property_descriptor methods[] = {
      {"probe", nullptr, probe, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"open", nullptr, open, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"process", nullptr, process, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"parameter", nullptr, parameter, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"release", nullptr, release, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, close, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"diagnostics", nullptr, diagnostics, nullptr, nullptr, nullptr, napi_default, nullptr},
#ifdef LOOM_FFGL_STUDY
      {"createStudySurface", nullptr, createStudySurface, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readStudySurface", nullptr, readStudySurface, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"destroyStudySurface", nullptr, destroyStudySurface, nullptr, nullptr, nullptr, napi_default, nullptr},
#endif
    };
    check(napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods));
    return exports;
  } catch (const std::exception &error) { return failure(env, error); }
}
