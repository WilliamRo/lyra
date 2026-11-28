"""Best-effort local host statistics for check-ins, using only the standard library."""

import ctypes
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import subprocess
import sys
import time

GIB = 1024 ** 3


def _linux(metrics):
  try:
    metrics['uptime_sec'] = float(Path('/proc/uptime').read_text().split()[0])
  except (OSError, ValueError, IndexError):
    pass
  info = {}
  for line in Path('/proc/meminfo').read_text().splitlines():
    key, _, value = line.partition(':')
    if key in ('MemTotal', 'MemAvailable', 'MemFree', 'Buffers', 'Cached'):
      info[key] = int(value.split()[0]) * 1024
  return info['MemTotal'], info.get('MemAvailable', sum(info.get(k, 0) for k in ('MemFree', 'Buffers', 'Cached')))


def _windows(metrics):
  kernel = ctypes.windll.kernel32
  kernel.GetTickCount64.restype = ctypes.c_uint64
  metrics['uptime_sec'] = kernel.GetTickCount64() / 1000

  class MemoryStatus(ctypes.Structure):
    _fields_ = [('length', ctypes.c_uint32), ('load', ctypes.c_uint32)] + [
      (key, ctypes.c_uint64) for key in ('total', 'available', 'page_total', 'page_free',
                                         'virtual_total', 'virtual_free', 'extended_free')]
  status = MemoryStatus()
  status.length = ctypes.sizeof(status)
  if not kernel.GlobalMemoryStatusEx(ctypes.byref(status)):
    raise OSError('memory counters unavailable')
  return status.total, status.available


def _mac(metrics):
  def read(*args):
    return subprocess.check_output(args, text=True, timeout=2, stderr=subprocess.DEVNULL)
  try:
    boot = re.search(r'\bsec\s*=\s*(\d+)', read('/usr/sbin/sysctl', '-n', 'kern.boottime'))
    if boot:
      metrics['uptime_sec'] = max(0.0, time.time() - int(boot[1]))
  except (OSError, subprocess.SubprocessError):
    pass
  total = int(read('/usr/sbin/sysctl', '-n', 'hw.memsize'))
  pages = read('/usr/bin/vm_stat')
  page_size = re.search(r'page size of (\d+) bytes', pages)
  if not page_size:
    raise ValueError('page size unavailable')
  counts = re.findall(r'^Pages (?:free|inactive|speculative):\s*(\d+)', pages, re.MULTILINE)
  if not counts:
    raise ValueError('page counts unavailable')
  return total, sum(map(int, counts)) * int(page_size[1])


def host_metrics():
  metrics = {'os': platform.system(), 'arch': platform.machine()}
  cpus = os.cpu_count()
  if cpus:
    metrics['cpu_count'] = cpus
  try:
    addresses = socket.gethostbyname_ex(socket.gethostname())[2]
    metrics['ip'] = next(ip for ip in addresses if not ip.startswith('127.'))
  except (OSError, StopIteration):
    pass
  try:
    disk = shutil.disk_usage(Path.home())
    if disk.total:
      metrics.update(disk_total_gb=disk.total / GIB, disk_free_gb=disk.free / GIB,
                     disk_used_pct=100 * disk.used / disk.total)
  except OSError:
    pass
  try:
    collector = {'linux': _linux, 'win32': _windows, 'darwin': _mac}.get(sys.platform)
    if collector:
      total, avail = collector(metrics)
      if total:
        available = max(0, min(total, avail))
        used = total - available
        metrics.update(mem_total_gb=total / GIB, mem_used_gb=used / GIB, mem_free_gb=available / GIB,
                       mem_used_pct=100 * used / total)
  except (OSError, ValueError, KeyError, IndexError, subprocess.SubprocessError):
    pass
  return metrics
