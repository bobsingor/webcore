// Linux open flags, whence values and mode bits (ADR-0003).

export const O_RDONLY = 0
export const O_WRONLY = 1
export const O_RDWR = 2
export const O_ACCMODE = 3
export const O_CREAT = 0o100
export const O_EXCL = 0o200
export const O_TRUNC = 0o1000
export const O_APPEND = 0o2000
export const O_DIRECTORY = 0o200000

export const SEEK_SET = 0
export const SEEK_CUR = 1
export const SEEK_END = 2

export const AT_FDCWD = -100

export const S_IFIFO = 0o010000
export const S_IFCHR = 0o020000
export const S_IFDIR = 0o040000
export const S_IFREG = 0o100000
export const S_IFSOCK = 0o140000

export const DEFAULT_PATH = '/usr/bin:/bin'

export type FileType = 'file' | 'dir' | 'chardev' | 'fifo' | 'socket'

export interface Stat {
  type: FileType
  mode: number
  ino: number
  nlink: number
  size: number
  atimeMs: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
}

export interface Dirent {
  name: string
  type: FileType
  ino: number
}
