const signedOut = document.querySelector('#signed-out');
const dashboard = document.querySelector('#dashboard');
const guildSelect = document.querySelector('#guild');
const notice = document.querySelector('#dashboard-notice');
const logoutButton = document.querySelector('#logout');
const configForm = document.querySelector('#config-form');
const profileForm = document.querySelector('#profile-form');
const saveConfigButton = document.querySelector('#save-config');
const saveProfileButton = document.querySelector('#save-profile');

async function request(path, options = {}) {
  const response = await fetch(`/api/admin/${path}`, {
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed with HTTP ${response.status}`);
  return result;
}

function setNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle('error', isError);
}

function fillSelect(id, placeholder, items, selected, label) {
  const select = document.querySelector(`#${id}`);
  const options = [new Option(placeholder, '')];
  for (const item of items) {
    options.push(new Option(label(item), item.id));
  }
  select.replaceChildren(...options);
  if (selected) select.value = selected;
}

async function loadOptions(guildId) {
  const [result, saved] = await Promise.all([
    request(`options?guild_id=${encodeURIComponent(guildId)}`),
    request(`config?guild_id=${encodeURIComponent(guildId)}`),
  ]);
  const config = saved.config || {
    panelTitle: 'Roblox Verification',
    panelDescription: "Verify your Roblox account to receive this server's verified role.",
  };
  const roles = result.roles.filter(role => role.id !== guildId && !role.managed);
  fillSelect('verified-role', 'Choose verified role', roles, config.verifiedRoleId, role => role.name);
  fillSelect('unverified-role', 'No unverified role', roles, config.unverifiedRoleId, role => role.name);
  fillSelect('panel-channel', 'Choose panel channel', result.channels, config.panelChannelId, channel => `#${channel.name}`);
  fillSelect('log-channel', 'Choose log channel', result.channels, config.logChannelId, channel => `#${channel.name}`);
  document.querySelector('#panel-title').value = config.panelTitle;
  document.querySelector('#panel-description').value = config.panelDescription;
  document.querySelector('#display-name').value = '';
  await loadStats(guildId);
  setNotice(saved.config ? 'Settings loaded.' : 'This server has not configured verification yet.');
}

async function loadStats(guildId) {
  const { stats } = await request(`stats?guild_id=${encodeURIComponent(guildId)}`);
  const grouped = new Map();
  let totalRoblox = 0;
  let totalCaptcha = 0;
  for (const row of stats) {
    const day = grouped.get(row.verification_day) || { roblox: 0, captcha: 0 };
    const total = Number(row.total) || 0;
    if (row.method === 'roblox') {
      day.roblox += total;
      totalRoblox += total;
    } else if (row.method === 'captcha') {
      day.captcha += total;
      totalCaptcha += total;
    }
    grouped.set(row.verification_day, day);
  }
  document.querySelector('#stat-total').textContent = String(totalRoblox + totalCaptcha);
  document.querySelector('#stat-roblox').textContent = String(totalRoblox);
  document.querySelector('#stat-captcha').textContent = String(totalCaptcha);
  const rows = [...grouped.entries()].sort(([a], [b]) => b.localeCompare(a));
  const tableRows = rows.map(([date, counts]) => {
    const tr = document.createElement('tr');
    for (const value of [date, counts.roblox, counts.captcha, counts.roblox + counts.captcha]) {
      const td = document.createElement('td');
      td.textContent = String(value);
      tr.append(td);
    }
    return tr;
  });
  if (!tableRows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = 'No verification activity in the last 90 days.';
    tr.append(td);
    tableRows.push(tr);
  }
  document.querySelector('#stats-rows').replaceChildren(...tableRows);
}

async function startDashboard() {
  try {
    const { user } = await request('session');
    const { guilds } = await request('guilds');
    signedOut.classList.add('hidden');
    dashboard.classList.remove('hidden');
    logoutButton.classList.remove('hidden');
    document.querySelector('#user-name').textContent = `Signed in as ${user.username}`;
    if (!guilds.length) {
      setNotice('No servers were found where you have Administrator permission and the bot is a member.', true);
      return;
    }
    guildSelect.replaceChildren(...guilds.map(guild => new Option(guild.name, guild.id)));
    guildSelect.addEventListener('change', () => loadOptions(guildSelect.value).catch(error => setNotice(error.message, true)));
    await loadOptions(guildSelect.value);
  } catch (error) {
    signedOut.classList.remove('hidden');
    dashboard.classList.add('hidden');
    document.querySelector('#signin-notice').textContent = error.message || 'Sign in with Discord to continue.';
  }
}

configForm.addEventListener('submit', async event => {
  event.preventDefault();
  saveConfigButton.disabled = true;
  try {
    const payload = {
      guildId: guildSelect.value,
      verifiedRoleId: document.querySelector('#verified-role').value,
      unverifiedRoleId: document.querySelector('#unverified-role').value || null,
      panelChannelId: document.querySelector('#panel-channel').value,
      logChannelId: document.querySelector('#log-channel').value,
      panelTitle: document.querySelector('#panel-title').value.trim(),
      panelDescription: document.querySelector('#panel-description').value.trim(),
    };
    await request('config', { method: 'PUT', body: JSON.stringify(payload) });
    setNotice('Verification settings saved. Run `/verification-panel` to publish the updated panel.');
  } catch (error) {
    setNotice(error.message, true);
  } finally {
    saveConfigButton.disabled = false;
  }
});

profileForm.addEventListener('submit', async event => {
  event.preventDefault();
  saveProfileButton.disabled = true;
  try {
    const displayName = document.querySelector('#display-name').value.trim();
    await request('profile', {
      method: 'PUT',
      body: JSON.stringify({ guildId: guildSelect.value, displayName }),
    });
    setNotice('Bot nickname updated for this server.');
  } catch (error) {
    setNotice(error.message, true);
  } finally {
    saveProfileButton.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  try {
    const result = await request('logout', { method: 'POST' });
    if (result) window.location.assign('/dashboard.html');
  } catch (error) {
    setNotice(error.message, true);
  } finally {
    logoutButton.disabled = false;
  }
});

startDashboard();
