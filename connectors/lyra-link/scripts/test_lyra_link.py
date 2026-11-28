# =============================================================================
# test_lyra_link.py: Offline unit tests for the lyra-link connector.
# Run: python3 -B .claude/skills/lyra-link/scripts/test_lyra_link.py
# =============================================================================

import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import lyra_link
from lyralib import activity, client, daemon, link, status, store, stream  # noqa: E402
from lyralib.client import LyraError  # noqa: E402

SELF = os.getpid()


class Base(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.mkdtemp(prefix='lyra-link-test-')
    os.environ['LYRA_LINK_STATE_DIR'] = self.tmp

  def tearDown(self):
    os.environ.pop('LYRA_LINK_STATE_DIR', None)


class ActivityTests(Base):

  def hook(self, event, now):
    return activity.handle_hook(json.dumps({'hook_event_name': event, 'session_id': 's1'}),
                                now=now, pid=SELF)

  def test_cycle_verifies_gate_and_advertises_jump(self):
    self.assertEqual(activity.advertise(SELF)[0], ['queue'])
    self.hook('UserPromptSubmit', time.time() - 5)
    self.assertEqual(activity.gate(SELF)['state'], 'busy')
    self.assertEqual(activity.advertise(SELF)[0], ['queue'])  # not yet verified
    self.hook('Stop', time.time())
    g = activity.gate(SELF)
    self.assertEqual((g['state'], g['verified'], g['cycles']), ('idle', True, 1))
    self.assertEqual(activity.advertise(SELF)[0], ['queue', 'jump'])
    self.assertEqual(activity.advertise(SELF, setting='queue')[0], ['queue'])

  def test_stale_busy_downgrades_to_queue(self):
    t = time.time()
    self.hook('UserPromptSubmit', t - 100)
    self.hook('Stop', t - 90)
    self.hook('UserPromptSubmit', t - 3000)  # missed Stop (for example an interrupt)
    g = activity.gate(SELF, now=t)
    self.assertTrue(g['stale'])
    self.assertEqual(activity.advertise(SELF, now=t)[0], ['queue'])

  def test_idle_prompt_notification_corrects_after_interrupt(self):
    self.hook('UserPromptSubmit', time.time() - 70)
    self.hook('Notification', time.time())
    self.assertEqual(activity.gate(SELF)['state'], 'idle')

  def test_hook_never_raises_on_garbage(self):
    self.assertIsNone(activity.handle_hook('not json', pid=SELF))
    self.assertIsNone(activity.handle_hook('{"hook_event_name": "PreToolUse"}', pid=SELF))

  def test_dead_pid_is_unknown(self):
    self.assertEqual(activity.gate(999999)['state'], 'unknown')


class StatusTests(unittest.TestCase):

  def test_statusline_shape(self):
    snap = {'model': {'id': 'claude-opus-5-5', 'display_name': 'Opus 5.5'}, 'effort': {'level': 'high'},
            'context_window': {'used_percentage': 41.5}, 'version': '2.1.332',
            'rate_limits': {'five_hour': {'used_percentage': 12, 'resets_at': 1795790000},
                            'seven_day': {'used_percentage': 40}}}
    st, usage = status.parse(snap)
    self.assertEqual((st['model'], st['effort'], st['context_pct']), ('Opus 5.5', 'high', 41.5))
    names = [m['name'] for m in usage['metrics']]
    self.assertEqual(names, ['5-hour window', 'Weekly window'])
    self.assertEqual(usage['metrics'][0]['remaining_pct'], 88.0)

  def test_missing_values_stay_none(self):
    st, usage = status.parse({})
    self.assertIsNone(st['model'])
    self.assertIsNone(usage)
    self.assertEqual(status.read('/nonexistent/file.json'), ({}, None))


class ClientTests(unittest.TestCase):

  def test_plain_http_only_to_loopback(self):
    self.assertEqual(client.check_url('http://127.0.0.1:8740/'), 'http://127.0.0.1:8740')
    client.check_url('https://lyra.example')
    with self.assertRaises(ValueError):
      client.check_url('http://lyra.example')


class ImageConnectorTests(Base):
  def test_join_and_checkin_capabilities(self):
    for handle, enabled in [('vision', True), ('plain', False)]:
      with patch.object(link, 'Client') as factory:
        remote = factory.return_value
        remote.base = 'http://localhost'
        remote.join.return_value = {'token': 'test', 'principal': {'handle': handle},
                                    'server': {'checkin_interval_sec': 15}, 'rotated': False}
        link.join(handle, remote.base, 'invite', 'script', link_session=False, supports_images=enabled)
        self.assertEqual(remote.join.call_args.args[0]['capabilities'], {'images': enabled})
        cfg = store.read_json(store.config_path(handle))
        self.assertEqual(cfg['supports_images'], enabled)
        self.assertEqual(daemon.checkin_payload(handle, cfg, SELF)['capabilities'], {'images': enabled})
    self.assertEqual(daemon.checkin_payload('legacy', {}, SELF)['capabilities'], {'images': True})

  def test_binary_client_upload_and_download(self):
    data = b'\x89PNG\r\n\x1a\n' + bytes(37)
    path = Path(self.tmp) / 'a b.png'
    path.write_bytes(data)
    dest = Path(self.tmp) / 'download' / 'image.png'
    c = client.Client('http://localhost', token='test')
    c.opener.open = Mock(side_effect=[io.BytesIO(b'{"attachment":{"id":42}}'), io.BytesIO(data)])
    self.assertEqual(c.upload_attachment(path), {'id': 42})
    c.download_attachment(42, dest)
    upload, download = (call.args[0] for call in c.opener.open.call_args_list)
    self.assertEqual(upload.get_header('X-filename'), 'a%20b.png')
    self.assertEqual(upload.data, data)
    self.assertEqual(download.get_header('Authorization'), 'Bearer test')
    self.assertEqual(download.full_url, 'http://localhost/api/v1/attachments/42')
    self.assertEqual(dest.read_bytes(), data)

  def test_send_and_reply_wire_payloads(self):
    c = client.Client('http://localhost')
    c.request = Mock()
    c.send('owner', '', attachment_ids=[9, 8])
    self.assertEqual(c.request.call_args.args[2]['attachment_ids'], [9, 8])
    c.reply(23, 'caption', attachment_ids=[6])
    self.assertEqual(c.request.call_args.args[1:3], ('/api/v1/messages/23/reply',
                     {'body': 'caption', 'mode': None, 'client_msg_id': None, 'attachment_ids': [6]}))

  def test_cli_repeated_images_and_reply_keys(self):
    c = Mock()
    c.upload_attachment.side_effect = lambda name: {'id': {'one': 1, 'two': 2}[name]}
    with patch.object(lyra_link, '_client', return_value=c), patch.object(lyra_link, 'out'):
      with patch('sys.stdin', io.StringIO('caption')):
        self.assertEqual(lyra_link.main(['send', 'vision', '--to', 'owner', '--stdin',
                                         '--image', 'two', '--image', 'one']), 0)
      self.assertEqual(c.send.call_args.args, ('owner', 'caption'))
      self.assertEqual(c.send.call_args.kwargs['attachment_ids'], [2, 1])
      keys = []
      for filename in ('one', 'two', 'two'):
        self.assertEqual(lyra_link.main(['reply', 'vision', '--to', '7', '--image', filename]), 0)
        self.assertEqual(c.reply.call_args.args, (7, ''))
        keys.append(c.reply.call_args.kwargs['client_msg_id'])
      self.assertNotEqual(keys[0], keys[1])
      self.assertEqual(keys[1], keys[2])
      self.assertEqual(lyra_link.main(['send', 'vision', '--to', 'owner']), 1)


class FakeClient:
  def __init__(self, queue):
    self.queue = list(queue)
    self.acks = []
    self.fail_ack = False

  def claim(self, wait=20):
    return self.queue.pop(0) if self.queue else {'lease_id': None, 'message': None}

  def ack(self, lease_id, outcome, reason=None):
    if self.fail_ack:
      raise LyraError(0, 'unreachable', 'down')
    self.acks.append((lease_id, outcome))
    return {'ok': True}


def got(mid, lease, retry=False):
  return {'lease_id': lease, 'attempt': 1, 'message': {
    'id': mid, 'conversation_id': 1, 'conversation_kind': 'owner_agent',
    'sender': {'handle': 'owner', 'display_name': 'Owner', 'kind': 'owner'},
    'body': f'body {mid}', 'mode': 'queue', 'retry': retry, 'reply_to': None, 'created_at': 1.0}}


class StreamTests(Base):

  def streamer(self, fake):
    store.write_json(store.config_path('dario'), {'server_url': 'http://127.0.0.1:1'})
    return stream.Streamer('dario', client=fake, owner_pid=SELF, out=[])

  def test_handoff_then_ack(self):
    fake = FakeClient([got(1, 'L1')])
    s = self.streamer(fake)
    s.step()
    self.assertEqual(s.out[0]['message_id'], 1)
    self.assertEqual(s.out[0]['source'], 'lyra')
    self.assertEqual(fake.acks, [('L1', 'delivered')])
    self.assertEqual(store.ledger_get('dario', 1)['state'], 'acked')

  def test_downloads_before_handoff_and_reports_individual_errors(self):
    message = got(7, 'L7')
    data = b'GIF89a'
    message['message']['attachments'] = [
      {'id': i, 'filename': '../picture.gif', 'mime_type': 'image/gif',
       'sha256': hashlib.sha256(data).hexdigest()} for i in (1, 2, 3)]
    fake = FakeClient([message])
    def download(aid, path):
      if aid == 2:
        raise LyraError(403, 'attachment_forbidden')
      store.atomic_write_bytes(path, data if aid == 1 else b'bad')
    fake.download_attachment = download
    s = self.streamer(fake)
    s.step()
    first, denied, corrupt = s.out[0]['attachments']
    dest = Path(first['local_path'])
    self.assertEqual(dest.parent, store.attachments_dir('dario').resolve())
    self.assertTrue(dest.is_absolute())
    self.assertEqual(dest.read_bytes(), data)
    self.assertIn('403', denied['download_error'])
    self.assertIn('checksum', corrupt['download_error'])
    self.assertNotIn('local_path', corrupt)
    self.assertEqual(fake.acks, [('L7', 'delivered')])

  def test_lost_ack_is_reconciled_not_redelivered(self):
    fake = FakeClient([got(2, 'L2'), got(2, 'L2b')])
    s = self.streamer(fake)
    fake.fail_ack = True
    s.step()                      # handed, ack lost
    self.assertEqual(store.ledger_get('dario', 2)['state'], 'handed')
    fake.fail_ack = False
    s2 = self.streamer(fake)      # restart: reconcile first
    s2.step()
    self.assertIn(('L2', 'delivered'), fake.acks)
    self.assertEqual(len(s.out) + len(s2.out), 1)  # never shown twice
    self.assertIn(('L2b', 'delivered'), fake.acks)  # re-offer closed without re-injection

  def test_crash_mid_handoff_reports_unconfirmed(self):
    store.ledger_set('dario', 3, state='handing', lease_id='L3')
    fake = FakeClient([])
    s = self.streamer(fake)
    s.step()
    self.assertEqual(fake.acks, [('L3', 'unconfirmed')])
    self.assertEqual(s.out, [])

  def test_owner_retry_is_reinjected_with_marker(self):
    store.ledger_set('dario', 4, state='unconfirmed', lease_id='L4')
    fake = FakeClient([got(4, 'L4b', retry=True)])
    s = self.streamer(fake)
    s.step()
    self.assertTrue(s.out[0]['retry'])

  def test_gate_blocks_claim_while_busy_and_after_handoff(self):
    store.write_json(store.advertised_path('dario'), {'modes': ['queue', 'jump']})
    activity.handle_hook('{"hook_event_name": "UserPromptSubmit"}', pid=SELF)
    fake = FakeClient([got(5, 'L5')])
    s = self.streamer(fake)
    s.step()
    self.assertEqual(s.out, [])   # busy: no claim
    activity.handle_hook('{"hook_event_name": "Stop"}', pid=SELF)
    s.step()
    self.assertEqual(s.out[0]['message_id'], 5)
    fake.queue.append(got(6, 'L6'))
    s.step()
    self.assertEqual(len(s.out), 1)  # waits for the turn the handoff starts
    time.sleep(0.6)
    activity.handle_hook('{"hook_event_name": "UserPromptSubmit"}', pid=SELF)
    activity.handle_hook('{"hook_event_name": "Stop"}', pid=SELF)
    s.step()
    self.assertEqual(s.out[1]['message_id'], 6)

  def test_revoked_flag_stops_stream(self):
    store.touch(store.revoked_path('dario'))
    s = self.streamer(FakeClient([]))
    s.step()
    self.assertTrue(s.should_exit)
    self.assertEqual(s.out[0]['event'], 'revoked')


if __name__ == '__main__':
  unittest.main()
