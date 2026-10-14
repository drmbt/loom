// loom-shm.node: the POSIX shared-memory half of PROTOCOL.md v1 (VN118).
//
// Node has no shm_open/mmap, so this is the one native piece the host adds beside dawn.node.
// N-API only (ABI-stable): built once against Node 24's headers, it loads in any Node >= 18
// and inside the SEA executable.
//
//   map(name, size, create) -> ArrayBuffer   the mapping, zero-copy; munmap when collected
//   unlink(name)                             shm_unlink (the test client plays the effect)
//
// `create` is the EFFECT's side (O_CREAT | ftruncate). The host always maps an existing
// object and takes its size from fstat, so `size` there is only a lower bound it checks.
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

typedef struct { void* addr; size_t len; } Mapping;

static void finalize(napi_env env, void* data, void* hint) {
  (void)env; (void)data;
  Mapping* m = (Mapping*)hint;
  if (m) { munmap(m->addr, m->len); free(m); }
}

static napi_value fail(napi_env env, const char* what, const char* name) {
  char msg[256];
  snprintf(msg, sizeof msg, "%s(\"%s\"): %s", what, name, strerror(errno));
  napi_throw_error(env, NULL, msg);
  return NULL;
}

static napi_value map_shm(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char name[64]; size_t nlen = 0;
  if (argc < 2 || napi_get_value_string_utf8(env, argv[0], name, sizeof name, &nlen) != napi_ok) {
    napi_throw_type_error(env, NULL, "map(name: string, size: number, create?: boolean)");
    return NULL;
  }
  double sized = 0; napi_get_value_double(env, argv[1], &sized);
  size_t size = (size_t)sized;
  bool create = false;
  if (argc > 2) napi_get_value_bool(env, argv[2], &create);

  int fd = shm_open(name, create ? (O_RDWR | O_CREAT) : O_RDWR, 0600);
  if (fd < 0) return fail(env, "shm_open", name);
  struct stat st;
  if (fstat(fd, &st) != 0) { close(fd); return fail(env, "fstat", name); }
  if (create && (size_t)st.st_size < size) {
    if (ftruncate(fd, (off_t)size) != 0) { close(fd); return fail(env, "ftruncate", name); }
    if (fstat(fd, &st) != 0) { close(fd); return fail(env, "fstat", name); }
  }
  size_t len = (size_t)st.st_size;
  if (len < size || len == 0) {
    close(fd);
    char msg[160];
    snprintf(msg, sizeof msg, "shm \"%s\" is %zu bytes; %zu needed", name, len, size);
    napi_throw_range_error(env, NULL, msg);
    return NULL;
  }
  void* addr = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  close(fd);
  if (addr == MAP_FAILED) return fail(env, "mmap", name);
  Mapping* m = (Mapping*)malloc(sizeof(Mapping));
  m->addr = addr; m->len = len;
  napi_value ab;
  napi_status s = napi_create_external_arraybuffer(env, addr, len, finalize, m, &ab);
  if (s != napi_ok) { munmap(addr, len); free(m); napi_throw_error(env, NULL, "external ArrayBuffer refused"); return NULL; }
  return ab;
}

static napi_value unlink_shm(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char name[64]; size_t nlen = 0;
  napi_get_value_string_utf8(env, argv[0], name, sizeof name, &nlen);
  napi_value r; napi_get_boolean(env, shm_unlink(name) == 0, &r);
  return r;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "map", NAPI_AUTO_LENGTH, map_shm, NULL, &fn);
  napi_set_named_property(env, exports, "map", fn);
  napi_create_function(env, "unlink", NAPI_AUTO_LENGTH, unlink_shm, NULL, &fn);
  napi_set_named_property(env, exports, "unlink", fn);
  return exports;
}
