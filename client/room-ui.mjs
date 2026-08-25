function isVerifiedDid(value) {
  return typeof value === 'string' && value.startsWith('did:key:');
}

function shortDid(value) {
  if (!isVerifiedDid(value) || value.length < 18) return value;
  return `${value.slice(8, 14)}…${value.slice(-6)}`;
}

export function populateRoomOptions(select, rooms, selectedRoom = '') {
  select.textContent = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = rooms.length ? 'Choose a public room' : 'No public rooms found';
  select.appendChild(placeholder);
  for (const value of rooms) {
    const room = typeof value === 'string' ? value : value?.room;
    if (!room) continue;
    const option = document.createElement('option');
    option.value = room;
    const topic = typeof value === 'object' && value?.topic ? ` — ${value.topic}` : '';
    option.textContent = `${room}${topic}`;
    if (room === selectedRoom) option.selected = true;
    select.appendChild(option);
  }
}

export function renderRoomMessages(container, messages, { reset = false } = {}) {
  if (reset) container.textContent = '';
  for (const message of messages) {
    const row = document.createElement('article');
    row.className = 'room-message';
    row.dataset.seq = String(message.seq ?? '');

    const meta = document.createElement('div');
    meta.className = 'room-message-meta';

    const author = document.createElement('code');
    const verified = isVerifiedDid(message.from);
    author.className = verified ? 'room-author verified' : 'room-author unsigned';
    author.textContent = verified
      ? shortDid(message.from)
      : `~${message.from || 'unknown'}`;
    author.title = verified ? message.from : 'Self-asserted nickname';

    const sequence = document.createElement('span');
    sequence.textContent = `#${message.seq ?? '?'} · ${message.ts || 'unknown time'}`;
    meta.append(author, sequence);

    const body = document.createElement('p');
    body.className = 'room-message-body';
    body.textContent = String(message.text ?? '');
    row.append(meta, body);
    container.appendChild(row);
  }
  container.scrollTop = container.scrollHeight;
}
