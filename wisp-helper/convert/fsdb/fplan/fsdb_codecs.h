// SPDX-License-Identifier: MIT
// FSDB token codecs, from the bounded Python token grammar.
#pragma once
#include <cstdint>
#include <cstring>
#include <algorithm>
#include <cstddef>
#include <vector>
#include <stdexcept>
#include <limits>
#include <memory>
#include <initializer_list>
#include <utility>
#include <zlib.h>
#include <zstd.h>
namespace fsdbraw {
using Bytes=std::vector<uint8_t>;
struct DecodeError:std::runtime_error{using std::runtime_error::runtime_error;};
struct Decoded{Bytes bytes;size_t consumed;};
namespace detail {
struct Lz {
 const uint8_t*src;size_t size,pos=0,limit;Bytes out;
 Lz(const uint8_t*p,size_t n,size_t lim):src(p),size(n),limit(lim){if(n&&!p)throw DecodeError("null input");}
 uint8_t byte(){if(pos==size)throw DecodeError("truncated LZ token");return src[pos++];}
 void literal(size_t n){if(n>size-pos||n>limit-out.size())throw DecodeError("LZ literal bounds");out.insert(out.end(),src+pos,src+pos+n);pos+=n;}
 void match(size_t d,size_t n){if(!d||d>out.size()||n>limit-out.size())throw DecodeError("LZ back-reference bounds");size_t start=out.size();out.resize(start+n);
  // Copy only nonoverlapping spans, doubling the available repeated history.
  size_t copied=0;while(copied<n){size_t span=std::min(n-copied,d+copied);std::memcpy(out.data()+start+copied,out.data()+start-d,span);copied+=span;}}
 size_t extend(size_t base){size_t n=0;for(;;){auto v=byte();if(v){if(base>limit||v>limit-base||n>limit-base-v)throw DecodeError("LZ extension limit");return n+base+v;}if(n>limit||255>limit-n)throw DecodeError("LZ extension limit");n+=255;}}
};
}
namespace detail {
/*per-thread output buffer for the zlib/zstd stages, reused across blocks: one allocation of the limit (2 MiB) per block
  could be mapped and freed each time; with transparent huge pages a fresh map can take a huge-page fault*/
inline uint8_t*scratch(size_t n){static thread_local std::unique_ptr<uint8_t[]> b;static thread_local size_t cap=0;if(cap<n){b.reset(new uint8_t[n]);cap=n;}return b.get();}
}
inline Decoded lz0(const uint8_t*data,size_t size,size_t limit=2*1024*1024){
 detail::Lz r(data,size,limit);bool after=false;
 for(;;){unsigned t=r.byte();
  if(t<=31){if(after){size_t d=1+t+(size_t(r.byte())<<5);r.match(d,3);r.literal(1);after=true;continue;}
   size_t n=t;bool lng=false;if(!n){unsigned e=r.byte();lng=e>=248;n=e<=248?32+e:size_t(256)<<(e-248);}r.literal(n);after=!lng;continue;}
  if(t>63){size_t d=1+(t&31)+(size_t(r.byte())<<5);r.match(d,(t>>5)+1);after=false;continue;}
  size_t length=t&31;if(!length)length=r.extend(31);
  unsigned low=r.byte(),high=r.byte();size_t d=(low&63)+(size_t(high)<<6);
  if(!d){if(t!=33||low||high)throw DecodeError("unknown lz0 end token");return {std::move(r.out),r.pos};}
  if(length>limit||3>limit-length)throw DecodeError("lz0 length limit");
  r.match(d,length+3);size_t tail=low>>6;r.literal(tail);after=tail!=0;
 }
}
inline Decoded lz1(const uint8_t*data,size_t size,size_t limit=2*1024*1024){
 detail::Lz r(data,size,limit);enum Mode{Main,First,Match,Token,Done};Mode mode=Main;unsigned t=0;
 if(!size)throw DecodeError("empty lz1 stream");
 if(data[0]>17){size_t n=r.byte()-17;r.literal(n);mode=n<4?Match:First;}
 for(;;){
  if(mode==Main){t=r.byte();if(t<16){size_t n=t?t:r.extend(15);if(n>limit||3>limit-n)throw DecodeError("lz1 length limit");r.literal(n+3);mode=First;continue;}mode=Token;}
  if(mode==First){t=r.byte();if(t<16){size_t d=2049+(t>>2)+(size_t(r.byte())<<2);r.match(d,3);mode=Done;}else mode=Token;}
  if(mode==Match){t=r.byte();mode=Token;}
  if(mode==Token){
   if(t>=64){size_t d=1+((t>>2)&7)+(size_t(r.byte())<<3);r.match(d,(t>>5)+1);}
   else if(t>=32){size_t n=t&31;if(!n)n=r.extend(31);unsigned lo=r.byte(),hi=r.byte();if(n>limit||2>limit-n)throw DecodeError("lz1 length limit");r.match(1+((lo|(size_t(hi)<<8))>>2),n+2);}
   else if(t>=16){size_t n=t&7;if(!n)n=r.extend(7);unsigned lo=r.byte(),hi=r.byte();size_t off=((t&8)<<11)+((lo|(size_t(hi)<<8))>>2);if(!off){if(t!=17||lo||hi)throw DecodeError("unknown lz1 end token");return {std::move(r.out),r.pos};}if(n>limit||2>limit-n)throw DecodeError("lz1 length limit");r.match(16384+off,n+2);}
   else {size_t d=1+(t>>2)+(size_t(r.byte())<<2);r.match(d,2);}mode=Done;
  }
  if(mode==Done){if(r.pos<2)throw DecodeError("lz1 tail underflow");unsigned tail=data[r.pos-2]&3;if(tail){r.literal(tail);mode=Match;}else mode=Main;}
 }
}
inline Bytes decompress(unsigned codec,const uint8_t*data,size_t size,size_t limit=2*1024*1024){
 if(size&&!data)throw DecodeError("null input");
 if(codec<2){auto d=codec==0?lz0(data,size,limit):lz1(data,size,limit);if(d.consumed!=size)throw DecodeError("trailing LZ bytes");return std::move(d.bytes);}
 if(codec==2){
  if(size>std::numeric_limits<uInt>::max()||limit>=std::numeric_limits<uInt>::max())throw DecodeError("zlib input/output limit");
  /*output buffer is not zero-filled: limit (2 MiB) >> a typical block (<= 64 KiB), and zeroing it per block cost ~20% of conversion CPU*/uint8_t*buf=detail::scratch(limit+1);z_stream s{};s.next_in=const_cast<Bytef*>(data);s.avail_in=uInt(size);s.next_out=buf;s.avail_out=uInt(limit+1);
  if(inflateInit(&s)!=Z_OK)throw DecodeError("zlib initialization");
  int rc=inflate(&s,Z_FINISH);size_t count=s.total_out;bool ok=rc==Z_STREAM_END&&s.total_in==size&&count<=limit;inflateEnd(&s);
  if(!ok)throw DecodeError("invalid/trailing/oversized zlib frame");
  return Bytes(buf,buf+count);
 }
 if(codec>=3&&codec<=5){size_t frame=ZSTD_findFrameCompressedSize(data,size);if(ZSTD_isError(frame)||frame!=size)throw DecodeError("invalid/trailing zstd frame");uint8_t*buf=detail::scratch(limit);size_t n=ZSTD_decompress(buf,limit,data,size);if(ZSTD_isError(n)||n>limit)throw DecodeError("zstd decode/output limit");return Bytes(buf,buf+n);}
 throw DecodeError("unsupported codec");
}
inline Bytes checked_payload(const uint8_t*data,size_t size){if(!size)throw DecodeError("empty checked payload");if(!data)throw DecodeError("null input");uint8_t x=0;for(size_t i=0;i<size;++i)x^=data[i];if(x)throw DecodeError("XOR8 checksum mismatch");return Bytes(data,data+size-1);}
inline Bytes decode_stages(const uint8_t*data,size_t size,const std::vector<unsigned>&methods,bool checksum=true,size_t limit=2*1024*1024){
 if(methods.empty())throw DecodeError("empty codec stages");
 if(size&&!data)throw DecodeError("null input");
 Bytes current=checksum?checked_payload(data,size):(size?Bytes(data,data+size):Bytes{});
 for(unsigned method:methods)current=decompress(method,current.data(),current.size(),limit);
 return current;
}
inline Bytes decode_stages(const Bytes&data,std::initializer_list<unsigned>methods,bool checksum=true,size_t limit=2*1024*1024){return decode_stages(data.data(),data.size(),std::vector<unsigned>(methods),checksum,limit);}
}
