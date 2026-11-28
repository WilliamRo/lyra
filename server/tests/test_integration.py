# =============================================================================
# test_integration.py: Real server + real lyra-link connector code, no Claude.
# =============================================================================

import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest

HERE = Path(__file__).resolve()
CANDIDATE_CONNECTORS = [
  HERE.parents[2] / 'connectors' / 'lyra-link' / 'scripts',
]
if len(HERE.parents) > 4:
  CANDIDATE_CONNECTORS.append(HERE.parents[4] / '.claude' / 'skills' / 'lyra-link' / 'scripts')
CONNECTOR = next((p for p in CANDIDATE_CONNECTORS if p.is_dir()), CANDIDATE_CONNECTORS[0])
sys.path.insert(0, str(HERE.parent))
if CONNECTOR.is_dir():
  sys.path.insert(0, str(CONNECTOR))

from test_server import ServerCase  # noqa: E402

try:
  from lyralib import echo, link, store, stream  # noqa: E402
  from lyralib.client import Client  # noqa: E402
except ImportError:  # connector not present next to this checkout
  link = None


@unittest.skipIf(link is None, 'lyra-link connector not found')
class ConnectorRoundTrip(ServerCase):

  def setUp(self):
    self.state = tempfile.mkdtemp(prefix='lyra-link-int-', dir=os.environ.get('LYRA_TEST_TMP'))
    os.environ['LYRA_LINK_STATE_DIR'] = self.state

  def tearDown(self):
    os.environ.pop('LYRA_LINK_STATE_DIR', None)

  def test_owner_image_to_connector_and_image_reply(self):
    owner = self.owner()
    recipient = self.agent(owner, 'visual')
    self.checkin(recipient, capabilities={'images': True})
    data = b'\x89PNG\r\n\x1a\n' + bytes(range(256))
    st, upload = owner.call('POST', '/api/v1/attachments', data, {'X-Filename': 'chart.png'})
    self.assertEqual(st, 200, upload)
    st, sent = owner.call('POST', '/api/v1/messages', {'to': recipient.pid, 'attachment_ids': [upload['attachment']['id']]})
    self.assertEqual(st, 200, sent)
    agent = Client(self.base, recipient.token)
    streamer = stream.Streamer('visual', client=agent, owner_pid=os.getpid(), out=[])
    streamer.step(wait=0)
    event = streamer.out[0]
    path = Path(event['attachments'][0]['local_path'])
    self.assertEqual(path.read_bytes(), data)
    image = agent.upload_attachment(path)
    reply = agent.reply(event['message_id'], '', attachment_ids=[image['id']])['message']
    self.assertEqual(reply['reply_to']['excerpt'], '[Image]')
    self.assertEqual(owner.call('GET', reply['attachments'][0]['url']), (200, data))

  def test_join_receive_reply_and_agent_to_agent(self):
    o = self.owner()
    st, inv = o.call('POST', '/api/v1/admin/invites', {'display_name': 'Dario', 'handle': 'dario'})
    res = link.join('dario', self.base, inv['code'], script=__file__, link_session=False)
    self.assertEqual(res['handle'], 'dario')
    creds = store.read_json(store.creds_path('dario'))
    agent = Client(self.base, creds['token'])
    agent.checkin({'instance_id': 'int', 'modes': ['queue']})

    # i. Owner -> Dario, handed to the session stream, reply lands on the original.
    st, sent = o.call('POST', '/api/v1/messages', {'to': creds['principal']['id'], 'body': 'Q-7731?'})
    s = stream.Streamer('dario', client=agent, owner_pid=os.getpid(), out=[])
    s.step(wait=2)
    ev = s.out[0]
    self.assertEqual((ev['text'], ev['from']['kind']), ('Q-7731?', 'owner'))
    agent.reply(ev['message_id'], 'A-7731', client_msg_id='r1')
    agent.react(ev['message_id'], '⌨️')
    st, msgs = o.call('GET', f"/api/v1/conversations/{sent['message']['conversation_id']}/messages")
    q, a = msgs['messages']
    self.assertEqual((q['state'], a['body'], a['reply_to']['id']), ('delivered', 'A-7731', q['id']))
    self.assertEqual(q['reactions'][0]['emoji'], '⌨️')

    # ii. Dario -> echo agent -> reply delivered back through Dario's stream.
    st, inv2 = o.call('POST', '/api/v1/admin/invites', {'display_name': 'Echo', 'handle': 'echo'})
    t = threading.Thread(target=echo.run, args=('echo',),
                         kwargs={'server': self.base, 'invite': inv2['code'], 'max_messages': 1},
                         daemon=True)
    t.start()
    for _ in range(50):
      if any(x['handle'] == 'echo' and x['online'] for x in agent.teammates()['teammates']):
        break
      threading.Event().wait(0.1)
    agent.send('echo', 'hello echo', client_msg_id='s1')
    t.join(30)
    s.step(wait=5)
    back = s.out[-1]
    self.assertEqual((back['from']['handle'], back['text'], back['conversation_kind']),
                     ('echo', 'echo: hello echo', 'agent_agent'))
    self.assertEqual(back['reply_to']['excerpt'], 'hello echo')
    st, b = o.call('GET', '/api/v1/board')
    echo_row = next(x for x in b['agents'] if x['handle'] == 'echo')
    self.assertEqual(echo_row['presence']['modes'], ['queue'])  # queue-only connector
    st, body = o.call('POST', '/api/v1/messages', {'to': echo_row['id'], 'body': 'x', 'mode': 'jump'})
    self.assertEqual(st, 422)


if __name__ == '__main__':
  unittest.main()
