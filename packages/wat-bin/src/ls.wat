;; ls [dir] — lists non-hidden directory entries, one per line. Exercises path_open + fd_readdir.
(module
  (import "wasi_snapshot_preview1" "args_sizes_get" (func $args_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_get" (func $args_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close" (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_readdir" (func $fd_readdir (param i32 i32 i32 i64 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))

  ;; Layout: 0 argc · 4 argv_buf_size · 16 opened fd · 24 nwritten/bufused · 48 write iovec
  ;;         128 strings · 1024 argv · 4096 argv_buf · 32768 dirent buffer
  (memory (export "memory") 1)
  (data (i32.const 128) "ls: cannot access '")
  (data (i32.const 160) "': No such file or directory\n")
  (data (i32.const 192) "': Not a directory\n")
  (data (i32.const 224) ".\n")

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

  (func (export "_start")
    (local $arg i32) (local $len i32) (local $dir i32) (local $path i32) (local $plen i32)
    (local $err i32) (local $fd i32) (local $used i32) (local $off i32) (local $name i32) (local $namlen i32)
    (drop (call $args_sizes_get (i32.const 0) (i32.const 4)))
    (drop (call $args_get (i32.const 1024) (i32.const 4096)))
    (if (i32.gt_u (i32.load (i32.const 0)) (i32.const 1))
      (then
        (local.set $arg (i32.load (i32.const 1028)))
        (local.set $len (call $strlen (local.get $arg))))
      (else
        (local.set $arg (i32.const 224))
        (local.set $len (i32.const 1))))
    (if (i32.eq (i32.load8_u (local.get $arg)) (i32.const 47)) ;; leading "/"
      (then
        (local.set $dir (i32.const 3))
        (local.set $path (i32.add (local.get $arg) (i32.const 1)))
        (local.set $plen (i32.sub (local.get $len) (i32.const 1)))
        (if (i32.eqz (local.get $plen))
          (then (local.set $path (i32.const 224)) (local.set $plen (i32.const 1)))))
      (else
        (local.set $dir (i32.const 4))
        (local.set $path (local.get $arg))
        (local.set $plen (local.get $len))))
    ;; oflags = O_DIRECTORY, rights_base = fd_readdir (bit 14)
    (local.set $err (call $path_open (local.get $dir) (i32.const 1) (local.get $path) (local.get $plen)
                                     (i32.const 2) (i64.const 16384) (i64.const 0) (i32.const 0) (i32.const 16)))
    (if (local.get $err)
      (then
        (drop (call $write_all (i32.const 2) (i32.const 128) (i32.const 19)))
        (drop (call $write_all (i32.const 2) (local.get $arg) (local.get $len)))
        (if (i32.eq (local.get $err) (i32.const 54)) ;; ENOTDIR
          (then (drop (call $write_all (i32.const 2) (i32.const 192) (i32.const 19))))
          (else (drop (call $write_all (i32.const 2) (i32.const 160) (i32.const 29)))))
        (call $proc_exit (i32.const 2))))
    (local.set $fd (i32.load (i32.const 16)))
    (drop (call $fd_readdir (local.get $fd) (i32.const 32768) (i32.const 32768) (i64.const 0) (i32.const 24)))
    (local.set $used (i32.load (i32.const 24)))
    ;; dirent: d_next u64 · d_ino u64 · d_namlen u32 · d_type u8 (24 bytes), then the name
    (block $done
      (loop $next
        (br_if $done (i32.gt_u (i32.add (local.get $off) (i32.const 24)) (local.get $used)))
        (local.set $namlen (i32.load (i32.add (i32.const 32784) (local.get $off))))
        (local.set $name (i32.add (i32.const 32792) (local.get $off)))
        (br_if $done (i32.gt_u (i32.add (local.get $name) (local.get $namlen))
                               (i32.add (i32.const 32768) (local.get $used))))
        (if (i32.ne (i32.load8_u (local.get $name)) (i32.const 46)) ;; skip hidden entries
          (then
            (drop (call $write_all (i32.const 1) (local.get $name) (local.get $namlen)))
            (drop (call $write_all (i32.const 1) (i32.const 225) (i32.const 1)))))
        (local.set $off (i32.add (local.get $off) (i32.add (i32.const 24) (local.get $namlen))))
        (br $next)))
    (drop (call $fd_close (local.get $fd)))
    (call $proc_exit (i32.const 0)))
)
