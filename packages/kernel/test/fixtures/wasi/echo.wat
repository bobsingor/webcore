;; echo [args...] — writes its arguments separated by spaces, then a newline.
(module
  (import "wasi_snapshot_preview1" "args_sizes_get" (func $args_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_get" (func $args_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))

  ;; Layout: 0 argc · 4 argv_buf_size · 24 nwritten · 48 iovec · 128 strings · 1024 argv · 4096 argv_buf
  (memory (export "memory") 1)
  (data (i32.const 128) " \n")

  (func $strlen (param $p i32) (result i32)
    (local $n i32)
    (block $done
      (loop $next
        (br_if $done (i32.eqz (i32.load8_u (i32.add (local.get $p) (local.get $n)))))
        (local.set $n (i32.add (local.get $n) (i32.const 1)))
        (br $next)))
    (local.get $n))

  (func $write_all (param $fd i32) (param $ptr i32) (param $len i32) (result i32)
    (local $err i32)
    (block $done
      (loop $next
        (br_if $done (i32.eqz (local.get $len)))
        (i32.store (i32.const 48) (local.get $ptr))
        (i32.store (i32.const 52) (local.get $len))
        (local.set $err (call $fd_write (local.get $fd) (i32.const 48) (i32.const 1) (i32.const 24)))
        (if (local.get $err) (then (return (local.get $err))))
        (local.set $ptr (i32.add (local.get $ptr) (i32.load (i32.const 24))))
        (local.set $len (i32.sub (local.get $len) (i32.load (i32.const 24))))
        (br $next)))
    (i32.const 0))

  ;; Builds the whole line at 32768 and writes it once, like libc stdio would.
  (func (export "_start")
    (local $argc i32) (local $i i32) (local $arg i32) (local $len i32) (local $j i32) (local $out i32)
    (drop (call $args_sizes_get (i32.const 0) (i32.const 4)))
    (drop (call $args_get (i32.const 1024) (i32.const 4096)))
    (local.set $argc (i32.load (i32.const 0)))
    (local.set $out (i32.const 32768))
    (local.set $i (i32.const 1))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (local.get $argc)))
        (if (i32.gt_u (local.get $i) (i32.const 1))
          (then
            (i32.store8 (local.get $out) (i32.const 32))
            (local.set $out (i32.add (local.get $out) (i32.const 1)))))
        (local.set $arg (i32.load (i32.add (i32.const 1024) (i32.shl (local.get $i) (i32.const 2)))))
        (local.set $len (call $strlen (local.get $arg)))
        (local.set $j (i32.const 0))
        (block $copied
          (loop $copy
            (br_if $copied (i32.ge_u (local.get $j) (local.get $len)))
            (i32.store8 (i32.add (local.get $out) (local.get $j))
                        (i32.load8_u (i32.add (local.get $arg) (local.get $j))))
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $copy)))
        (local.set $out (i32.add (local.get $out) (local.get $len)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)))
    (i32.store8 (local.get $out) (i32.const 10))
    (drop (call $write_all (i32.const 1) (i32.const 32768) (i32.sub (i32.add (local.get $out) (i32.const 1)) (i32.const 32768))))
    (call $proc_exit (i32.const 0)))
)
