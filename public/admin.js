const token = () => document.getElementById('adminToken').value.trim();
const headers = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` });
const message = (text, error = false) => {
  const element = document.getElementById('message');
  element.textContent = text;
  element.style.color = error ? '#ffae8b' : '#8ee0ae';
};

async function load() {
  try {
    const response = await fetch('/admin/api/keys', { headers: headers() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message);
    render(data.keys);
    message(`Updated ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    message(error.message || 'Could not load keys.', true);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[character]));
}

function render(keys) {
  document.getElementById('total').textContent = keys.length;
  document.getElementById('healthy').textContent = keys.filter((key) => key.enabled && key.status === 'healthy').length;
  document.getElementById('requests').textContent = keys.reduce((sum, key) => sum + key.usage.requests, 0).toLocaleString();
  document.getElementById('tokens').textContent = keys.reduce((sum, key) => sum + key.usage.totalTokens, 0).toLocaleString();
  document.getElementById('keys').innerHTML = keys.map((key) => `
    <tr>
      <td>${escapeHtml(key.label)}<br><small>${key.maskedKey}</small></td>
      <td><span class="badge ${key.enabled ? key.status : 'off'}">${key.enabled ? key.status : 'disabled'}</span></td>
      <td>${key.usage.requests.toLocaleString()}</td>
      <td>${key.usage.totalTokens.toLocaleString()}</td>
      <td>${key.usage.lastUsedAt ? new Date(key.usage.lastUsedAt).toLocaleString() : 'Never'}</td>
      <td class="actions">
        <button data-action="edit" data-id="${key.id}" data-label="${encodeURIComponent(key.label)}">Edit</button>
        <button data-action="toggle" data-id="${key.id}" data-enabled="${!key.enabled}">${key.enabled ? 'Disable' : 'Enable'}</button>
        <button class="danger" data-action="remove" data-id="${key.id}">Remove</button>
      </td>
    </tr>`).join('');
}

async function updateKey(id, body) {
  const response = await fetch(`/admin/api/keys/${id}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message);
  await load();
}

async function handleAction(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;

  try {
    if (action === 'toggle') {
      await updateKey(id, { enabled: button.dataset.enabled === 'true' });
    } else if (action === 'edit') {
      const label = prompt('Label:', decodeURIComponent(button.dataset.label));
      if (label === null) return;
      const key = prompt('New Gemini API key (leave blank to keep current):');
      await updateKey(id, { label, ...(key ? { key } : {}) });
    } else if (action === 'remove' && confirm('Remove this API key?')) {
      const response = await fetch(`/admin/api/keys/${id}`, { method: 'DELETE', headers: headers() });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message);
      await load();
    }
  } catch (error) {
    message(error.message || 'Action failed.', true);
  }
}

document.getElementById('addForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const response = await fetch('/admin/api/keys', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        key: document.getElementById('key').value,
        label: document.getElementById('label').value,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message);
    event.target.reset();
    await load();
  } catch (error) {
    message(error.message || 'Could not add key.', true);
  }
});

document.getElementById('keys').addEventListener('click', handleAction);
document.getElementById('refresh').addEventListener('click', load);
document.getElementById('adminToken').addEventListener('change', load);
