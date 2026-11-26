// SPDX-License-Identifier: MIT
// Indexed VC source: block-at-a-time reads, no byte scanning or history materialization.
#pragma once
#include "fsdb_values.h"
#include <array>
#include <functional>
#include <memory>
#include <vector>
#include <utility>
namespace fsdbraw {
// Reader is a half-open window in nominal physical block coordinates. Actual
// short decoded ends advance directly to the next index: no nominal-hole bytes.
// Provider owns decompression/cache policy. Reader retains only current block
// plus an eight-byte straddle scratch; returned take pointers are ephemeral.
class BlockStream {
 public:
 using Block=std::vector<uint8_t>;
 using Provider=std::function<std::shared_ptr<const Block>(uint32_t)>;
 using PeriodOf=std::function<uint32_t(uint32_t)>;
 size_t position=0;
 BlockStream(Provider provider,PeriodOf period_of,uint32_t first,size_t offset,
             uint32_t end,size_t end_offset,uint32_t period,size_t nominal=65536)
  :provider_(std::move(provider)),period_of_(std::move(period_of)),index_(first),end_(end),period_(period),offset_(offset),end_offset_(end_offset),nominal_(nominal){
  value_detail::require(bool(provider_)&&bool(period_of_)&&nominal_&&offset<nominal_&&end_offset<nominal_,"invalid block stream source/window");
  value_detail::require(first<end||(first==end&&offset<end_offset),"empty/backwards block stream window");
 }
 const uint8_t* take(size_t n){
  value_detail::require(n<=scratch_.size(),"block stream take exceeds eight-byte scratch");
  if(!n)return scratch_.data();
  // fast path when the bytes are inside the loaded block (same checks as ensure() would pass)
  if(current_&&offset_<available_()&&n<=available_()-offset_){const uint8_t*p=current_->data()+offset_;offset_+=n;position+=n;return p;}
  ensure();
  if(n<=available_()-offset_){const uint8_t*p=current_->data()+offset_;advance(n);return p;}
  for(size_t i=0;i<n;i++)scratch_[i]=byte();
  return scratch_.data();
 }
 uint8_t byte(){if(current_&&offset_<available_()){uint8_t v=(*current_)[offset_];offset_++;position++;return v;}/*fast path*/ensure();uint8_t v=(*current_)[offset_];advance(1);return v;}
 uint32_t word(){const auto*p=take(4);return uint32_t(p[0])|(uint32_t(p[1])<<8)|(uint32_t(p[2])<<16)|(uint32_t(p[3])<<24);}
 uint64_t read8(){return value_detail::load64(take(8));}
 uint32_t block_index()const{return index_;}
 size_t block_offset()const{return offset_;}
 private:
 Provider provider_;PeriodOf period_of_;uint32_t index_,end_,period_;size_t offset_,end_offset_,nominal_;std::shared_ptr<const Block> current_;std::array<uint8_t,8> scratch_{};
 size_t available_()const{return index_==end_?end_offset_:current_->size();}
 void advance(size_t n){value_detail::require(n<=std::numeric_limits<size_t>::max()-position,"block stream byte position overflow");offset_+=n;position+=n;}
 void ensure(){
  if(current_&&offset_<available_())return;  // loaded block still has bytes (all checks below pass)
  for(;;){
   value_detail::require(index_<end_||(index_==end_&&offset_<end_offset_),"truncated indexed VC window");
   if(!current_){
    value_detail::require(period_of_(index_)==period_,"VC stream crosses native period");
    current_=provider_(index_);
    value_detail::require(bool(current_)&&!current_->empty()&&current_->size()<=nominal_,"invalid decoded VC block");
    value_detail::require(offset_<current_->size()&&(index_!=end_||end_offset_<=current_->size()),"VC window outside decoded block");
   }
   if(offset_<available_())return;
   value_detail::require(index_<end_&&index_!=UINT32_MAX,"truncated decoded VC block");
   ++index_;offset_=0;current_.reset();
  }
 }
};
}
