# =============================================================================
# test_lyra_link.py: Offline unit tests for the lyra-link connector.
# Run: python3 -B .claude/skills/lyra-link/scripts/test_lyra_link.py
# =============================================================================

import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lyralib import activity, client, status, store, stream  # noqa: E402
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
