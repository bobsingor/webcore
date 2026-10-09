;; wc — counts lines, words and bytes on stdin, printed GNU-style ("%7d %7d %7d\n").
(module
  (import "wasi_snapshot_preview1" "fd_read" (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))

  ;; Layout: 24 nread/nwritten · 32 read iovec · 48 write iovec · 64..80 digit scratch
  ;;         256 output line · 32768 io buffer
  (memory (export "memory") 1)

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

  (func $is_space (param $c i32) (result i32)
    (i32.or (i32.eq (local.get $c) (i32.const 32))
            (i32.and (i32.ge_u (local.get $c) (i32.const 9)) (i32.le_u (local.get $c) (i32.const 13)))))

  ;; Writes $n right-aligned in a 7-wide field at $out. Returns bytes written.
  (func $fmt (param $n i32) (param $out i32) (result i32)
    (local $tmp i32) (local $len i32) (local $i i32) (local $j i32)
    (local.set $tmp (i32.const 80))
    (loop $digit
      (local.set $tmp (i32.sub (local.get $tmp) (i32.const 1)))
      (i32.store8 (local.get $tmp) (i32.add (i32.const 48) (i32.rem_u (local.get $n) (i32.const 10))))
      (local.set $n (i32.div_u (local.get $n) (i32.const 10)))
      (br_if $digit (i32.ne (local.get $n) (i32.const 0))))
    (local.set $len (i32.sub (i32.const 80) (local.get $tmp)))
    (block $padded
      (loop $pad
        (br_if $padded (i32.ge_s (local.get $i) (i32.sub (i32.const 7) (local.get $len))))
        (i32.store8 (i32.add (local.get $out) (local.get $i)) (i32.const 32))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $pad)))
    (block $copied
      (loop $copy
        (br_if $copied (i32.ge_u (local.get $j) (local.get $len)))
        (i32.store8 (i32.add (local.get $out) (i32.add (local.get $i) (local.get $j)))
                    (i32.load8_u (i32.add (local.get $tmp) (local.get $j))))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $copy)))
    (i32.add (local.get $i) (local.get $len)))

  (func (export "_start")
    (local $lines i32) (local $words i32) (local $bytes i32) (local $inword i32)
    (local $n i32) (local $j i32) (local $c i32) (local $o i32)
    (block $eof
      (loop $read
        (i32.store (i32.const 32) (i32.const 32768))
        (i32.store (i32.const 36) (i32.const 32768))
        (br_if $eof (call $fd_read (i32.const 0) (i32.const 32) (i32.const 1) (i32.const 24)))
        (local.set $n (i32.load (i32.const 24)))
        (br_if $eof (i32.eqz (local.get $n)))
        (local.set $bytes (i32.add (local.get $bytes) (local.get $n)))
        (local.set $j (i32.const 0))
        (block $chunk_done
          (loop $scan
            (br_if $chunk_done (i32.ge_u (local.get $j) (local.get $n)))
            (local.set $c (i32.load8_u (i32.add (i32.const 32768) (local.get $j))))
            (if (i32.eq (local.get $c) (i32.const 10))
              (then (local.set $lines (i32.add (local.get $lines) (i32.const 1)))))
            (if (call $is_space (local.get $c))
              (then (local.set $inword (i32.const 0)))
              (else
                (if (i32.eqz (local.get $inword))
                  (then
                    (local.set $inword (i32.const 1))
                    (local.set $words (i32.add (local.get $words) (i32.const 1)))))))
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $scan)))
        (br $read)))
    (local.set $o (i32.const 256))
    (local.set $o (i32.add (local.get $o) (call $fmt (local.get $lines) (local.get $o))))
    (i32.store8 (local.get $o) (i32.const 32))
    (local.set $o (i32.add (local.get $o) (i32.const 1)))
    (local.set $o (i32.add (local.get $o) (call $fmt (local.get $words) (local.get $o))))
    (i32.store8 (local.get $o) (i32.const 32))
    (local.set $o (i32.add (local.get $o) (i32.const 1)))
    (local.set $o (i32.add (local.get $o) (call $fmt (local.get $bytes) (local.get $o))))
    (i32.store8 (local.get $o) (i32.const 10))
    (local.set $o (i32.add (local.get $o) (i32.const 1)))
    (drop (call $write_all (i32.const 1) (i32.const 256) (i32.sub (local.get $o) (i32.const 256))))
    (call $proc_exit (i32.const 0)))
)
