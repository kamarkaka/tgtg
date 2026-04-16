const loginView = document.getElementById('login-view');
const mainView = document.getElementById('main-view');
const logoutBtn = document.getElementById('logout-btn');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const itemIdInput = document.getElementById('item-id-input');
const addBtn = document.getElementById('add-btn');
const itemsList = document.getElementById('items-list');
const emptyMsg = document.getElementById('empty-msg');
const actionError = document.getElementById('action-error');

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

async function checkSession() {
  const res = await fetch('/api/session');
  const data = await res.json();
  if (data.authenticated) {
    showMain();
  } else {
    showLogin();
  }
}

function showLogin() {
  show(loginView);
  hide(mainView);
  hide(logoutBtn);
}

function showMain() {
  hide(loginView);
  show(mainView);
  show(logoutBtn);
  loadItems();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hide(loginError);
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    }),
  });
  if (res.ok) {
    showMain();
  } else {
    loginError.textContent = 'Invalid credentials';
    show(loginError);
  }
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  showLogin();
});

async function loadItems() {
  const res = await fetch('/api/items');
  if (!res.ok) return;
  const items = await res.json();
  itemsList.innerHTML = '';
  if (items.length === 0) {
    show(emptyMsg);
  } else {
    hide(emptyMsg);
    for (const item of items) {
      const li = document.createElement('li');
      const info = document.createElement('span');
      info.textContent = item.displayName
        ? `${item.displayName} (${item.itemId})`
        : item.itemId;
      li.appendChild(info);
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.addEventListener('click', () => deleteItem(item.itemId));
      li.appendChild(del);
      itemsList.appendChild(li);
    }
  }
}

let errorTimeout;
function showError(msg) {
  clearTimeout(errorTimeout);
  actionError.textContent = msg;
  show(actionError);
  errorTimeout = setTimeout(() => hide(actionError), 5000);
}

async function handleApiError(res, defaultMsg) {
  const data = await res.json().catch(() => ({}));
  showError(data.error || defaultMsg);
}

addBtn.addEventListener('click', async () => {
  const itemId = itemIdInput.value.trim();
  if (!itemId) return;
  const res = await fetch('/api/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId }),
  });
  if (res.ok) {
    itemIdInput.value = '';
    loadItems();
  } else {
    await handleApiError(res, 'Failed to add item');
  }
});

itemIdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addBtn.click();
});

async function deleteItem(itemId) {
  const res = await fetch(`/api/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
  if (res.ok) {
    loadItems();
  } else {
    await handleApiError(res, 'Failed to delete item');
  }
}

checkSession();
