function isVerifiedDid(value) {
  return typeof value === 'string' && value.startsWith('did:key:');
}

function shortDid(value) {
  if (!isVerifiedDid(value) || value.length < 18) return value;
  return `${value.slice(8, 14)}…${value.slice(-6)}`;
}

function contactButton(label, action, did, sequence) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'contact-action';
  button.textContent = label;
  button.dataset.contactAction = action;
  button.dataset.did = did;
  button.dataset.seq = String(sequence ?? '');
  button.title = action === 'copy-did'
    ? `Copy ${did}`
    : `Reply to ${did} about message #${sequence ?? '?'}`;
  button.setAttribute?.('aria-label', button.title);
  return button;
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

export function renderRoomMessages(container, messages, { reset = false, userDid = '' } = {}) {
  if (reset) container.textContent = '';
  for (const message of messages) {
    const row = document.createElement('article');
    const ownMessage = Boolean(userDid) && message.from === userDid;
    row.className = ownMessage ? 'room-message own' : 'room-message';
    row.dataset.seq = String(message.seq ?? '');
    row.dataset.tclk = String(message.text ?? '').startsWith('tclk1 ') ? 'true' : 'false';

    const meta = document.createElement('div');
    meta.className = 'room-message-meta';

    const authorLine = document.createElement('div');
    authorLine.className = 'room-author-line';
    const author = document.createElement('code');
    const verified = isVerifiedDid(message.from);
    author.className = verified ? 'room-author verified' : 'room-author unsigned';
    author.textContent = verified
      ? `${ownMessage ? 'You · ' : ''}${shortDid(message.from)}`
      : `~${message.from || 'unknown'}`;
    author.title = verified ? message.from : 'Self-asserted nickname';
    authorLine.appendChild(author);
    if (verified && !ownMessage) {
      const actions = document.createElement('span');
      actions.className = 'contact-actions';
      actions.append(
        contactButton('Copy DID', 'copy-did', message.from, message.seq),
        contactButton('Reply', 'reply', message.from, message.seq),
      );
      authorLine.appendChild(actions);
    }

    const sequence = document.createElement('span');
    sequence.textContent = `#${message.seq ?? '?'} · ${message.ts || 'unknown time'}`;
    meta.append(authorLine, sequence);

    const body = document.createElement('p');
    body.className = 'room-message-body';
    body.textContent = String(message.text ?? '');
    row.append(meta, body);
    container.appendChild(row);
  }
  container.scrollTop = container.scrollHeight;
}
