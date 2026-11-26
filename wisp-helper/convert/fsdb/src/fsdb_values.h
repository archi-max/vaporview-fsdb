// SPDX-License-Identifier: MIT
// Qualified FSDB value-change (VC) subset decoder. Standalone C++17.
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>
// Value encodings this decoder reads, by our own codec names (the numbers are the on-disk codes):
//   ENC_SCALAR   1-bit values with a clock-repeat form          ENC_DIRECT     direct value/unknown planes
//   ENC_WORDS    value/unknown word pairs (ENC_WORDS_ALT reads the same way)
//   ENC_WORDS_XOR  word pairs, each XOR the previous value (ENC_WORDS_XOR_ALT reads the same way)
//   ENC_PLANES   byte-packed value plane then unknown plane (unknown plane omitted when unchanged)
//   ENC_PLANES_XOR  ENC_PLANES with each plane XOR the previous event's (zero at stream start)
// WCZ_FSDB_MUTANT_PLANES_ABSOLUTE: test-only red mutant (reads ENC_PLANES_XOR as absolute planes).
#ifdef WCZ_FSDB_MUTANT_PLANES_ABSOLUTE
#define WCZ_FSDB_PLANES_XOR 0
#else
#define WCZ_FSDB_PLANES_XOR 1
#endif
// SINGLE SOURCE: the bus value encodings this decoder accepts. The decoder below and the converter's per-stream header check
// (run_plan_threaded.cpp streamRefusal) both use it, so they cannot drift.
#define WCZ_FSDB_CODECS 0,4,5,10,11,24,25,26
// ENC_PLANES width limit. Default 16777216: ENC_PLANES streams of any width are read as absolute planes, the reading that
// matched a reference decode on every wide stream checked. Other builds:
//   -DWCZ_FSDB_PLANES_MAX_BITS=33           narrow profile: wider ENC_PLANES streams are refused (listed per stream, not decoded)
//   -DWCZ_FSDB_PLANES_WIDE_XOR=1            development only: wide (>33) ENC_PLANES read as ENC_PLANES_XOR;
//                                           it did not match the reference decode and is kept only as a test arm
// The converter's streamRefusal uses the same limit.
#ifndef WCZ_FSDB_PLANES_MAX_BITS
#define WCZ_FSDB_PLANES_MAX_BITS 16777216
#endif
#ifndef WCZ_FSDB_PLANES_WIDE_XOR
#define WCZ_FSDB_PLANES_WIDE_XOR 0
#endif
namespace fsdbraw {
enum : unsigned { ENC_SCALAR=0, ENC_DIRECT=4, ENC_WORDS_ALT=5, ENC_WORDS=10, ENC_PLANES=11, ENC_WORDS_XOR_ALT=24, ENC_WORDS_XOR=25, ENC_PLANES_XOR=26 };
struct ValueError:std::runtime_error{using std::runtime_error::runtime_error;};
struct ValueStats{size_t consumed=0;uint64_t count=0,first=0,last=0;};
namespace value_detail {
inline void require(bool ok,const char* message){if(!ok)throw ValueError(message);}
inline bool codec_ok(unsigned k){static const unsigned K[]={WCZ_FSDB_CODECS};for(unsigned x:K)if(x==k)return true;return false;}
struct Cursor{
 const uint8_t* data;size_t length,position=0;
 const uint8_t* take(size_t n){require(position<=length&&n<=length-position,"truncated VC stream");if(!n)return data;auto*p=data+position;position+=n;return p;}
 uint8_t byte(){return *take(1);}
 uint32_t word(){const auto*p=take(4);return uint32_t(p[0])|(uint32_t(p[1])<<8)|(uint32_t(p[2])<<16)|(uint32_t(p[3])<<24);}
};
inline uint64_t load64(const uint8_t*p){
 uint64_t v=0;
#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
 std::memcpy(&v,p,8);
#else
 for(unsigned j=0;j<8;j++)v|=uint64_t(p[j])<<(j*8);
#endif
 return v;
}
inline void store_word(uint8_t* p,uint32_t v,size_t n){
#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
 std::memcpy(p,&v,n);
#else
 for(size_t j=0;j<n;j++)p[j]=uint8_t(v>>(j*8));
#endif
}
template<class Reader>
inline uint64_t delta(Reader&c,uint8_t flag,const std::vector<uint64_t>&table,bool raw_time_deltas=false){
 const unsigned widths[4]={1,2,4,0};unsigned mode=(flag>>4)&3,n=raw_time_deltas&&mode==3?8:widths[mode];auto*p=c.take(n);uint64_t code=0;
 for(unsigned j=0;j<n;j++)code|=uint64_t(p[j])<<(8*j);
 if(raw_time_deltas){
  // A direct 64-bit time is stored as high32 then low32, each word little endian.
  if(n==8)code=(code<<32)|(code>>32);
  return code;
 }
 require(code<table.size(),"VC delta code outside native dictionary");return table[size_t(code)];
}
inline uint32_t reverse32(uint32_t v){
 v=((v>>1)&0x55555555u)|((v&0x55555555u)<<1);
 v=((v>>2)&0x33333333u)|((v&0x33333333u)<<2);
 v=((v>>4)&0x0f0f0f0fu)|((v&0x0f0f0f0fu)<<4);
 return (v>>24)|((v>>8)&0xff00u)|((v<<8)&0xff0000u)|(v<<24);
}
// WCB position0 is the declared MSB. Reverse the whole declared width,
// carrying across word boundaries before reversing each emitted word.
inline void emit_msb_plane(const std::vector<uint32_t>& words,uint32_t bits,uint8_t* output,size_t bytes){
 const unsigned pad=unsigned(words.size()*32-bits);
 for(size_t j=0;j<words.size();j++){
  size_t top=words.size()-1-j;uint32_t value=pad?(words[top]<<pad)|(top?words[top-1]>>(32-pad):0):words[top];
  value=reverse32(value);size_t offset=j*4,n=bytes-offset;if(n>4)n=4;store_word(output+offset,value,n);
 }
 if(bits&7)output[bytes-1]&=uint8_t((1u<<(bits&7))-1);
}
template<class Reader>
inline void direct_planes(Reader& input,uint32_t bits,uint8_t* output,size_t bytes){
 size_t i=0,destination=0;
 constexpr uint64_t mask=0x0101010101010101ull,gather=0x0102040810204080ull;
 // No complete value copy: only eight logic codes may straddle a block.
 for(;i+8<=bits;i+=8,++destination){uint64_t word=load64(input.take(8));require(!(word&0xfcfcfcfcfcfcfcfcull),"unknown direct logic code");output[destination]=uint8_t(((word&mask)*gather)>>56);output[bytes+destination]=uint8_t((((word>>1)&mask)*gather)>>56);}
 if(i<bits){uint8_t v=0,u=0;for(unsigned j=0;i<bits;i++,j++){uint8_t code=input.byte();require(code<=3,"unknown direct logic code");v|=(code&1)<<j;u|=((code>>1)&1)<<j;}output[destination]=v;output[bytes+destination]=u;}

}
}
// Callback storage is reused: consume/copy planes synchronously, do not retain
// its pointer. Each call starts a native stream at time0 and zero XOR state.
// Planes store declared-MSB at bit0, matching the WCB record format.
// Stops at C0/C1 and returns consumed; caller owns any following framing.
template<class Reader,class Fn>
ValueStats decode_values_reader(Reader& cursor,uint32_t bits,
 const std::vector<uint64_t>& table,Fn callback,
 uint64_t max_events=std::numeric_limits<uint64_t>::max(),bool raw_time_deltas=false){
 using namespace value_detail;
 const size_t initial_position=cursor.position;
 require(bits&&bits<=16u*1024u*1024u,"VC width outside limit");require(raw_time_deltas?table.empty():(!table.empty()&&table[0]==0),"invalid native delta dictionary/time mode");
 uint8_t kind=cursor.byte();
 // Encodings: see the codec list at the top of this file (ENC_WORDS_ALT reads as ENC_WORDS, ENC_WORDS_XOR_ALT as ENC_WORDS_XOR).
 require(codec_ok(kind),"unsupported stream header");
 if(kind==ENC_SCALAR)require(bits==1,"scalar VC width mismatch");
 else{require(cursor.byte()==0,"unsupported stream header flags");require(cursor.word()==bits,"stream header/declaration width mismatch");}
 size_t bytes=(size_t(bits)+7)/8,words=(size_t(bits)+31)/32;
 if(kind==ENC_PLANES)require(bits<=WCZ_FSDB_PLANES_MAX_BITS,"packed-plane stream width outside qualified profile");
 const bool wide_planes_xor=kind==ENC_PLANES&&WCZ_FSDB_PLANES_WIDE_XOR&&bits>33;
 std::vector<uint32_t> packed_v,packed_u;if(kind==ENC_PLANES||kind==ENC_PLANES_XOR){packed_v.resize(words);packed_u.resize(words);}
 std::vector<uint8_t> planes(bytes*2,0);std::vector<uint32_t> previous_a,previous_b;
 if(kind==ENC_WORDS_XOR||kind==ENC_WORDS_XOR_ALT||kind==ENC_PLANES_XOR||wide_planes_xor){previous_a.assign(words,0);previous_b.assign(words,0);}
 ValueStats stats;uint64_t time=0,history_time[3]={0,0,0};uint8_t history_value[2]={0,0};
 auto emit=[&](uint64_t tick){
  if(!stats.count){stats.first=tick;}stats.last=tick;++stats.count;
  if(kind==ENC_SCALAR){history_time[0]=history_time[1];history_time[1]=history_time[2];history_time[2]=tick;history_value[0]=history_value[1];history_value[1]=planes[0]|uint8_t(planes[1]<<1);}
  callback(tick,planes.data(),planes.size());
 };
 while(true){
  uint8_t flag=cursor.byte();
  if(flag==0xc0||flag==0xc1){if(kind==ENC_PLANES)require(stats.count>0,"empty packed-plane stream is not qualified");require(cursor.position>=initial_position,"VC position moved backwards");stats.consumed=cursor.position-initial_position;return stats;}
  require(stats.count<max_events,"VC event count exceeds limit");
  if(kind==ENC_SCALAR){
   if((flag&0xc0)==0x40){
    uint64_t repeat=0;unsigned mode=(flag>>4)&3;
    if(mode==0){repeat=flag&15;repeat=repeat?repeat-1:cursor.byte();}
    else if(mode==1){const auto*p=cursor.take(2);repeat=uint32_t(p[0])|(uint32_t(p[1])<<8);}
    else if(mode==2){repeat=cursor.word();}
    else throw ValueError("unsupported scalar clock count mode flag="+std::to_string(flag)+" position="+std::to_string(cursor.position-1));
    require(stats.count>=3,"scalar clock repeat lacks three timestamp history");require(repeat<=max_events-stats.count,"clock repeat exceeds event limit");
    const uint64_t steps[2]={history_time[1]-history_time[0],history_time[2]-history_time[1]};const uint8_t values[2]={history_value[0],history_value[1]};
    for(uint64_t i=0;i<repeat;i++){uint64_t step=steps[i&1];require(step<=std::numeric_limits<uint64_t>::max()-time,"clock timestamp overflow");time+=step;uint8_t value=values[i&1];planes[0]=value&1;planes[1]=(value>>1)&1;emit(time);}
    continue;
   }
   if(flag&0xc0)throw ValueError("unsupported scalar sequence mode flag="+std::to_string(flag)+" position="+std::to_string(cursor.position-1));
   uint8_t value=flag&15;value=value?uint8_t(value-1):cursor.byte();require(value<=3,"unknown scalar logic code");
   uint64_t step=delta(cursor,flag,table,raw_time_deltas);require(step<=std::numeric_limits<uint64_t>::max()-time,"VC timestamp overflow");time+=step;planes[0]=value&1;planes[1]=(value>>1)&1;
  }else{
   require(!(flag&~uint8_t(kind==ENC_DIRECT?0x30:0x38)),"unsupported bus clock/sequence/mask mode");
   uint64_t step=delta(cursor,flag,table,raw_time_deltas);require(step<=std::numeric_limits<uint64_t>::max()-time,"VC timestamp overflow");time+=step;
   if(kind==ENC_DIRECT)direct_planes(cursor,bits,planes.data(),bytes);
   else if(kind==ENC_PLANES||kind==ENC_PLANES_XOR){
    // Byte-packed value plane, then unknown plane (omitted when the unknown-plane-unchanged flag is set).
    // Unlike ENC_WORDS these are contiguous planes, not interleaved value/unknown word pairs.
    for(size_t w=0;w<words;w++){size_t n=std::min(size_t(4),bytes-w*4);auto*p=cursor.take(n);uint32_t a=0;for(size_t j=0;j<n;j++)a|=uint32_t(p[j])<<(8*j);packed_v[w]=a;}
    for(size_t w=0;w<words;w++){uint32_t b=0;if(!(flag&8)){size_t n=std::min(size_t(4),bytes-w*4);auto*p=cursor.take(n);for(size_t j=0;j<n;j++)b|=uint32_t(p[j])<<(8*j);}packed_u[w]=b;}
    if((kind==ENC_PLANES_XOR&&WCZ_FSDB_PLANES_XOR)||wide_planes_xor){for(size_t w=0;w<words;w++){packed_v[w]^=previous_a[w];packed_u[w]^=previous_b[w];previous_a[w]=packed_v[w];previous_b[w]=packed_u[w];}}
    for(size_t w=0;w<words;w++)packed_v[w]^=packed_u[w];
    emit_msb_plane(packed_v,bits,planes.data(),bytes);emit_msb_plane(packed_u,bits,planes.data()+bytes,bytes);
   }else{
    const unsigned pad=unsigned(words*32-bits);uint32_t prior_v=0,prior_u=0;
    for(size_t w=0;w<words;w++){
     uint32_t a,b;
     if(flag&8){a=cursor.word();b=0;}else{b=cursor.word();a=cursor.word();}
     if(kind==ENC_WORDS_XOR||kind==ENC_WORDS_XOR_ALT){a^=previous_a[w];b^=previous_b[w];previous_a[w]=a;previous_b[w]=b;}
     uint32_t rv=reverse32(a^b),ru=reverse32(b);size_t offset=(words-1-w)*4,n=std::min(size_t(4),bytes-offset);
     store_word(planes.data()+offset,pad?(rv>>pad)|(prior_v<<(32-pad)):rv,n);
     store_word(planes.data()+bytes+offset,pad?(ru>>pad)|(prior_u<<(32-pad)):ru,n);
     prior_v=rv;prior_u=ru;
    }
    if(bits&7){uint8_t mask=uint8_t((1u<<(bits&7))-1);planes[bytes-1]&=mask;planes[2*bytes-1]&=mask;}
   }
  }
  emit(time);
 }
}
// Compatibility wrapper: same bounded value grammar on contiguous bytes.
template<class Fn>
ValueStats decode_values(const uint8_t* data,size_t length,uint32_t bits,
 const std::vector<uint64_t>& table,Fn callback,
 uint64_t max_events=std::numeric_limits<uint64_t>::max(),bool raw_time_deltas=false){
 value_detail::require(data||!length,"null VC data");
 value_detail::Cursor cursor{data,length};
 return decode_values_reader(cursor,bits,table,callback,max_events,raw_time_deltas);
}

}
