# =============================================================================
# cli.py: lyra-server serve | check-config | init-admin | reset-password |
#         backup | restore
# =============================================================================

import argparse
import getpass
import json
import logging
import signal
import sys
import threading

from . import __version__, backup as backup_mod, config


def _password(args):
  if args.password_stdin:
    pw = sys.stdin.readline().rstrip('\n')
  else:
    pw = getpass.getpass('Password: ')
    if getpass.getpass('Repeat: ') != pw:
      raise SystemExit('passwords do not match')
  return pw


def _settings(args):
  s = config.load(config_path=getattr(args, 'config', None))
  return config.validate(s)


def _print(obj):
  print(json.dumps(obj, indent=2, ensure_ascii=False))


def cmd_check(args):
  s = _settings(args)
  _print({'ok': True, 'version': __version__, **config.describe(s)})
  return 0


def cmd_serve(args):
  from .core import Lyra
  from .web import LyraHTTPServer
  logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING,
                      format='%(asctime)s %(levelname)s %(name)s %(message)s')
  s = _settings(args)
  app = Lyra(s)
  if not app.admin_exists():
    print('warning: no administrator yet; run `lyra-server init-admin`', file=sys.stderr)
  httpd = LyraHTTPServer(app)
  app.start()
  stop = threading.Event()

  def _term(*_a):
    if not stop.is_set():
      stop.set()
      threading.Thread(target=httpd.shutdown, daemon=True).start()
  signal.signal(signal.SIGTERM, _term)
  signal.signal(signal.SIGINT, _term)
  where = f'{s.scheme}://{s.bind}:{s.port}'
  print(f'lyra-server {__version__} listening on {where} (data {s.data_path})', flush=True)
  try:
    httpd.serve_forever(poll_interval=0.5)
  finally:
    app.stop()
    httpd.server_close()
    app.db.close()
  return 0


def cmd_init_admin(args):
  from .core import Lyra
  s = _settings(args)
  app = Lyra(s)
  out = app.init_admin(args.username, _password(args), display_name=args.display_name)
  _print({'created': out, 'data_dir': str(s.data_path)})
  return 0


def cmd_reset_password(args):
  from .core import Lyra
  s = _settings(args)
  app = Lyra(s)
  _print(app.reset_password(args.username, _password(args)))
  return 0


def cmd_backup(args):
  s = _settings(args)
  _print(backup_mod.backup(s.db_path, out=args.out, keep=s.backup_keep))
  return 0


def cmd_restore(args):
  s = _settings(args)
  _print(backup_mod.restore(args.source, s.db_path, force=args.force))
  return 0


def build_parser():
  p = argparse.ArgumentParser(prog='lyra-server', description='Lyra self-hosted server')
  p.add_argument('--version', action='version', version=__version__)
  sub = p.add_subparsers(dest='cmd', required=True)

  def add(name, fn, help_):
    sp = sub.add_parser(name, help=help_)
    sp.add_argument('--config', help='TOML settings file (else LYRA_CONFIG)')
    sp.set_defaults(fn=fn)
    return sp

  sp = add('serve', cmd_serve, 'run the server')
  sp.add_argument('-v', '--verbose', action='store_true')
  add('check-config', cmd_check, 'validate settings and print a summary')
  for name, fn, help_ in (('init-admin', cmd_init_admin, 'create the administrator'),
                          ('reset-password', cmd_reset_password, 'set a new admin password')):
    sp = add(name, fn, help_)
    sp.add_argument('--username', required=True)
    sp.add_argument('--password-stdin', action='store_true')
    if name == 'init-admin':
      sp.add_argument('--display-name')
  sp = add('backup', cmd_backup, 'online backup with rotation')
  sp.add_argument('--out', help='explicit target file (skips rotation)')
  sp = add('restore', cmd_restore, 'restore a backup into the data directory')
  sp.add_argument('source')
  sp.add_argument('--force', action='store_true', help='move an existing database aside')
  return p


def main(argv=None):
  args = build_parser().parse_args(argv)
  try:
    return args.fn(args)
  except config.ConfigError as exc:
    print(f'config error: {exc}', file=sys.stderr)
    return 2
  except Exception as exc:  # noqa: BLE001
    from .events import ApiError
    if isinstance(exc, (ApiError, FileExistsError, FileNotFoundError, RuntimeError)):
      print(f'error: {exc}', file=sys.stderr)
      return 1
    raise


if __name__ == '__main__':
  raise SystemExit(main())
