;; cat [files...] — copies files (or stdin, or "-") to stdout.
;; Paths open relative to fd 3, the first preopen (node:wasi preopens what it is given there).
(module
  (import "wasi_snapshot_preview1" "args_sizes_get" (func $args_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_get" (func $args_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read" (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close" (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))

  ;; Layout: 0 argc · 4 argv_buf_size · 16 opened fd · 24 nread/nwritten · 32 read iovec
  ;;         48 write iovec · 128 strings · 1024 argv · 4096 argv_buf · 32768 io buffer
  (memory (export "memory") 1)
  (data (i32.const 128) "cat: ")
  (data (i32.const 136) ": No such file or directory\n")
  (data (i32.const 168) ": cannot open\n")

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

  ;; Copies fd to stdout until EOF. Returns a WASI errno.
  (func $copy (param $fd i32) (result i32)
    (local $err i32) (local $n i32)
    (loop $next
      (i32.store (i32.const 32) (i32.const 32768))
      (i32.store (i32.const 36) (i32.const 32768))
      (local.set $err (call $fd_read (local.get $fd) (i32.const 32) (i32.const 1) (i32.const 24)))
      (if (local.get $err) (then (return (local.get $err))))
      (local.set $n (i32.load (i32.const 24)))
      (if (i32.eqz (local.get $n)) (then (return (i32.const 0))))
      (local.set $err (call $write_all (i32.const 1) (i32.const 32768) (local.get $n)))
      (if (local.get $err) (then (return (local.get $err))))
      (br $next))
    (i32.const 0))

  (func (export "_start")
    (local $argc i32) (local $i i32) (local $arg i32) (local $len i32)
    (local $dir i32) (local $path i32) (local $plen i32) (local $err i32) (local $status i32)
    (drop (call $args_sizes_get (i32.const 0) (i32.const 4)))
    (drop (call $args_get (i32.const 1024) (i32.const 4096)))
    (local.set $argc (i32.load (i32.const 0)))
    (if (i32.le_u (local.get $argc) (i32.const 1))
      (then
        (drop (call $copy (i32.const 0)))
        (call $proc_exit (i32.const 0))))
    (local.set $i (i32.const 1))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (local.get $argc)))
        (local.set $arg (i32.load (i32.add (i32.const 1024) (i32.shl (local.get $i) (i32.const 2)))))
        (local.set $len (call $strlen (local.get $arg)))
        (if (i32.and (i32.eq (local.get $len) (i32.const 1))
                     (i32.eq (i32.load8_u (local.get $arg)) (i32.const 45))) ;; "-"
          (then (drop (call $copy (i32.const 0))))
          (else
            (if (i32.eq (i32.load8_u (local.get $arg)) (i32.const 47)) ;; leading "/"
              (then
                (local.set $dir (i32.const 3))
                (local.set $path (i32.add (local.get $arg) (i32.const 1)))
                (local.set $plen (i32.sub (local.get $len) (i32.const 1))))
              (else
                (local.set $dir (i32.const 4))
                (local.set $path (local.get $arg))
                (local.set $plen (local.get $len))))
            ;; rights_base = fd_read (bit 1)
            (local.set $err (call $path_open (local.get $dir) (i32.const 1) (local.get $path) (local.get $plen)
                                             (i32.const 0) (i64.const 2) (i64.const 0) (i32.const 0) (i32.const 16)))
            (if (local.get $err)
              (then
                (drop (call $write_all (i32.const 2) (i32.const 128) (i32.const 5)))
                (drop (call $write_all (i32.const 2) (local.get $arg) (local.get $len)))
                (if (i32.eq (local.get $err) (i32.const 44)) ;; ENOENT
                  (then (drop (call $write_all (i32.const 2) (i32.const 136) (i32.const 28))))
                  (else (drop (call $write_all (i32.const 2) (i32.const 168) (i32.const 14)))))
                (local.set $status (i32.const 1)))
              (else
                (drop (call $copy (i32.load (i32.const 16))))
                (drop (call $fd_close (i32.load (i32.const 16))))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)))
    (call $proc_exit (local.get $status)))
)
