// SPDX-License-Identifier: MIT
// A fixed thread pool for one fan-out at a time.
// run(n, f) calls f(i) for every i < n on the pool's threads and the caller's, and returns when all calls are done.
// Indices are taken in order (an atomic counter), so the caller puts the most expensive work first.
// Only the command thread calls run(); it never nests.
#pragma once
#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

class Pool {
 public:
  explicit Pool(unsigned threads) {
    for (unsigned k = 1; k < threads; k++) th_.emplace_back([this] { loop(); });  // (the caller is the last thread)
  }
  ~Pool() {
    { std::lock_guard<std::mutex> lk(m_); stop_ = true; }
    cv_.notify_all();
    for (auto &t : th_) t.join();
  }
  unsigned threads() const { return (unsigned)th_.size() + 1; }
  void run(size_t n, const std::function<void(size_t)> &f) {
    if (n == 0) return;
    if (n == 1 || th_.empty()) { for (size_t i = 0; i < n; i++) f(i); return; }
    {
      std::lock_guard<std::mutex> lk(m_);
      job_ = &f; n_ = n; next_.store(0); busy_ = th_.size(); gen_++;
    }
    cv_.notify_all();
    work(f, n);
    std::unique_lock<std::mutex> lk(m_);
    done_.wait(lk, [this] { return busy_ == 0; });
    job_ = nullptr;
  }

 private:
  void work(const std::function<void(size_t)> &f, size_t n) {
    for (;;) {
      const size_t i = next_.fetch_add(1);
      if (i >= n) return;
      f(i);
    }
  }
  void loop() {
    uint64_t seen = 0;
    for (;;) {
      const std::function<void(size_t)> *f;
      size_t n;
      {
        std::unique_lock<std::mutex> lk(m_);
        cv_.wait(lk, [&] { return stop_ || gen_ != seen; });
        if (stop_) return;
        seen = gen_; f = job_; n = n_;
      }
      work(*f, n);
      std::lock_guard<std::mutex> lk(m_);
      if (--busy_ == 0) done_.notify_one();
    }
  }
  std::vector<std::thread> th_;
  std::mutex m_;
  std::condition_variable cv_, done_;
  const std::function<void(size_t)> *job_ = nullptr;
  size_t n_ = 0, busy_ = 0;
  std::atomic<size_t> next_{0};
  uint64_t gen_ = 0;
  bool stop_ = false;
};
