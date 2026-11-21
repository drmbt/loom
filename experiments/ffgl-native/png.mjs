/** Minimal still-image decoder for the export: 8-bit, non-interlaced PNG to RGBA8 rows, top row first.
 *  Loom's media texture is rgba8unorm-srgb and holds the file's bytes as they are, so this must not
 *  colour-manage: a PNG carrying an ICC profile is refused instead of being decoded differently. */
import {inflateSync} from 'node:zlib';
const SIGNATURE=[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a];
export function decodePng(bytes){
 const fail=(why)=>{throw Error(`PNG: ${why}`);};
 if(bytes.length<33||SIGNATURE.some((b,i)=>bytes[i]!==b))fail('not a PNG file');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 let at=8,header=null;const data=[];
 while(at+12<=bytes.length){
  const length=view.getUint32(at),type=String.fromCharCode(...bytes.subarray(at+4,at+8));
  const body=bytes.subarray(at+8,at+8+length);at+=12+length;
  if(type==='IHDR')header={width:view.getUint32(body.byteOffset-bytes.byteOffset),height:view.getUint32(body.byteOffset-bytes.byteOffset+4),depth:body[8],colour:body[9],interlace:body[12]};
  else if(type==='IDAT')data.push(body);
  else if(type==='iCCP')fail('carries an ICC profile; convert it to plain sRGB first');
  else if(type==='IEND')break;
 }
 if(!header)fail('missing IHDR');
 const channels={0:1,2:3,4:2,6:4}[header.colour];
 if(header.depth!==8||channels===undefined||header.interlace!==0)fail(`only 8-bit non-interlaced grey/RGB/RGBA is supported (depth ${header.depth}, colour type ${header.colour}, interlace ${header.interlace})`);
 const {width,height}=header,stride=width*channels,raw=inflateSync(Buffer.concat(data));
 if(raw.length!==(stride+1)*height)fail('pixel data has the wrong length');
 const rows=new Uint8Array(stride*height);
 for(let y=0;y<height;y++){
  const filter=raw[y*(stride+1)],src=y*(stride+1)+1,dst=y*stride;
  for(let x=0;x<stride;x++){
   const a=x>=channels?rows[dst+x-channels]:0,b=y>0?rows[dst+x-stride]:0,c=x>=channels&&y>0?rows[dst+x-stride-channels]:0;
   let predicted=0;
   if(filter===1)predicted=a;else if(filter===2)predicted=b;else if(filter===3)predicted=(a+b)>>1;
   else if(filter===4){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);predicted=pa<=pb&&pa<=pc?a:pb<=pc?b:c;}
   else if(filter!==0)fail(`unknown row filter ${filter}`);
   rows[dst+x]=(raw[src+x]+predicted)&255;
  }
 }
 const rgba=new Uint8Array(width*height*4);
 for(let i=0,o=0;i<width*height;i++,o+=4){
  const p=i*channels;
  if(channels>=3){rgba[o]=rows[p];rgba[o+1]=rows[p+1];rgba[o+2]=rows[p+2];rgba[o+3]=channels===4?rows[p+3]:255;}
  else{rgba[o]=rgba[o+1]=rgba[o+2]=rows[p];rgba[o+3]=channels===2?rows[p+1]:255;}
 }
 return {width,height,rgba};
}
