const STORAGE_HOST = "botcHelperHostPin";
const screenParam = new URLSearchParams(window.location.search).get("screen");
const lockedScreen = ["player", "host"].includes(screenParam) ? screenParam : "";
const STORAGE_PLAYER = lockedScreen ? `botcHelperPlayer:${lockedScreen}` : "botcHelperPlayer";

let mode = "public";
localStorage.removeItem(STORAGE_HOST);
sessionStorage.removeItem(STORAGE_HOST);
let hostPin = "";
let playerAuth = readPlayerAuth();
let state = null;
let events = null;
let toastTimer = null;
let serverOffsetMs = 0;
let selectedChatPlayerId = null;
let seenHostRequestIds = null;
let knownHostMessageIds = null;
let readHostMessageIds = new Set();

const app = document.querySelector("#app");

function readPlayerAuth() {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_PLAYER) || "null");
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function roleTag(role) {
  if (!role) return `<span class="tag">미배정</span>`;
  const teamClass = role.team === "악" ? "evil" : "good";
  return `
    <span class="tag ${teamClass}">${escapeHtml(role.team)}</span>
    <span class="tag">${escapeHtml(role.typeLabel)}</span>
  `;
}

function showToast(message) {
  const old = document.querySelector(".toast");
  if (old) old.remove();
  const box = document.createElement("div");
  box.className = "toast";
  box.textContent = message;
  document.body.appendChild(box);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.remove(), 3200);
}

function pendingAbilityRequests() {
  return (state?.abilityRequests || []).filter((request) => request.status === "pending");
}

function playerOriginMessages(nextState) {
  const messages = [];
  Object.entries(nextState?.messages || {}).forEach(([playerId, list]) => {
    (list || []).forEach((message) => {
      if (message.from === "player") messages.push({ ...message, playerId });
    });
  });
  return messages;
}

function markPlayerMessagesRead(playerId) {
  if (!playerId) return;
  (state?.messages?.[playerId] || []).forEach((message) => {
    if (message.from === "player") readHostMessageIds.add(message.id);
  });
}

function unreadPlayerMessageCount(playerId) {
  return (state?.messages?.[playerId] || []).filter(
    (message) => message.from === "player" && !readHostMessageIds.has(message.id),
  ).length;
}

function watchHostNotifications(nextState) {
  if (mode !== "host" || !nextState?.valid) return;
  const pending = (nextState.abilityRequests || []).filter((request) => request.status === "pending");
  const currentIds = new Set(pending.map((request) => request.id));
  const playerMessages = playerOriginMessages(nextState);
  const messageIds = new Set(playerMessages.map((message) => message.id));
  if (!seenHostRequestIds) {
    seenHostRequestIds = currentIds;
    knownHostMessageIds = messageIds;
    readHostMessageIds = new Set(messageIds);
    return;
  }
  const fresh = pending.filter((request) => !seenHostRequestIds.has(request.id));
  seenHostRequestIds = currentIds;
  const freshMessages = playerMessages.filter((message) => !knownHostMessageIds?.has(message.id));
  knownHostMessageIds = messageIds;
  if (freshMessages.length) {
    const firstMessage = freshMessages[0];
    const player = (nextState.players || []).find((item) => item.id === firstMessage.playerId);
    showToast(`새 비밀 메시지: ${player?.name || "플레이어"}`);
    return;
  }
  if (fresh.length) {
    const first = fresh[0];
    showToast(`새 능력 요청: ${first.playerName} / ${first.role?.name || "역할"}`);
  }
}

async function api(path, body = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error || "요청에 실패했어요.");
  return payload.result;
}

function connect(targetMode) {
  if (events) events.close();
  mode = targetMode;
  seenHostRequestIds = null;
  knownHostMessageIds = null;
  readHostMessageIds = new Set();
  let url = `/events?mode=${encodeURIComponent(mode)}`;
  if (mode === "host") {
    url += `&pin=${encodeURIComponent(hostPin)}`;
  }
  if (mode === "player" && playerAuth) {
    url += `&playerId=${encodeURIComponent(playerAuth.playerId)}&secret=${encodeURIComponent(playerAuth.secret)}`;
  }
  events = new EventSource(url);
  events.addEventListener("state", (event) => {
    const nextState = JSON.parse(event.data);
    watchHostNotifications(nextState);
    state = nextState;
    if (state.serverNow) {
      serverOffsetMs = Date.now() - state.serverNow;
    }
    render();
  });
  events.onerror = () => {
    document.body.classList.add("offline");
  };
}

function phaseLabel() {
  if (!state) return "연결 중";
  if (state.phase === "night") return `${state.night}번째 밤`;
  if (state.phase === "day") return `${state.day}번째 낮`;
  return "대기실";
}

function minPlayers() {
  return state?.minPlayers || 5;
}

function maxPlayers() {
  return state?.maxPlayers || 15;
}

function serverNow() {
  return Date.now() - serverOffsetMs;
}

function voteStage(active) {
  if (!active) return "idle";
  return serverNow() < (active.voteStartedAt || active.prepEndsAt || 0) ? "prep" : "voting";
}

function voteMsLeft(active) {
  if (!active) return 0;
  const target = voteStage(active) === "prep" ? active.voteStartedAt || active.prepEndsAt : active.deadlineAt;
  return Math.max(0, (target || 0) - serverNow());
}

function voteSecondsLeft(active) {
  return Math.ceil(voteMsLeft(active) / 1000);
}

function voteTimerMarkup(active) {
  const stage = voteStage(active);
  const duration = stage === "prep" ? active?.prepDurationMs || 3000 : active?.voteDurationMs || 15000;
  const left = voteSecondsLeft(active);
  const percent = Math.max(0, Math.min(100, (voteMsLeft(active) / duration) * 100));
  return `
    <div class="vote-clock" data-deadline="${active.deadlineAt}" data-prep-end="${active.voteStartedAt || active.prepEndsAt || 0}" data-prep-duration="${active.prepDurationMs || 3000}" data-vote-duration="${active.voteDurationMs || 15000}" data-duration="${duration}" style="--time-left:${percent}%">
      <span class="vote-clock-label">${stage === "prep" ? "준비" : "투표"}</span>
      <span class="vote-countdown">${left}</span>
    </div>
  `;
}

function voteStatusText(status) {
  if (status === "yes") return "찬성";
  if (status === "no") return "반대";
  if (status === "timeout") return "자동 반대";
  if (status === "choice_yes") return "찬성 예약";
  if (status === "choice_no") return "반대 예약";
  if (status === "current") return "진행 중";
  return "대기";
}

function nightStatusText(status) {
  if (status === "done") return "완료";
  if (status === "current") return "현재";
  return "대기";
}

function sortedPlayers() {
  return [...(state?.players || [])].sort((left, right) => left.seat - right.seat);
}

function ensureSelectedChatPlayer() {
  const players = sortedPlayers();
  if (!players.length) {
    selectedChatPlayerId = null;
    return null;
  }
  const selected = players.find((player) => player.id === selectedChatPlayerId);
  if (!selected) {
    selectedChatPlayerId = null;
    return null;
  }
  return selected;
}

function boardPosition(index, count) {
  const angle = -90 + (index * 360) / Math.max(1, count);
  const radians = (angle * Math.PI) / 180;
  const radius = count > 12 ? 40 : 39;
  return {
    x: 50 + Math.cos(radians) * radius,
    y: 50 + Math.sin(radians) * radius,
  };
}

function clockNumerals() {
  return [
    ["XII", 50, 8],
    ["III", 92, 50],
    ["VI", 50, 92],
    ["IX", 8, 50],
  ]
    .map(
      ([label, x, y]) =>
        `<span class="clock-numeral" style="left:${x}%;top:${y}%">${label}</span>`,
    )
    .join("");
}

function playerStatusList(player) {
  const statuses = [player.alive ? "생존" : "사망"];
  if (!player.alive && player.voteToken) statuses.push("유령표");
  if (player.poisoned) statuses.push("중독");
  if (player.drunk) statuses.push("취함");
  if (player.protected) statuses.push("보호");
  if (player.fortuneTellerRedHerring) statuses.push("점쟁이 미끼");
  return statuses;
}

function playerStatusTags(player) {
  return playerStatusList(player).map((status) => `<span class="token-status">${status}</span>`).join("");
}

function boardStatusMarkers(player) {
  const markers = [];
  const unread = unreadPlayerMessageCount(player.id);
  if (unread) markers.push({ key: "message", label: unread > 9 ? "9+" : "말" });
  if (player.online === false) markers.push({ key: "offline", label: "끊" });
  if (player.poisoned) markers.push({ key: "poisoned", label: "중" });
  if (player.drunk) markers.push({ key: "drunk", label: "취" });
  if (player.protected) markers.push({ key: "protected", label: "보" });
  if (player.fortuneTellerRedHerring) markers.push({ key: "red-herring", label: "악" });
  if (!player.alive) markers.push({ key: "dead", label: "사" });
  if (!player.alive && player.voteToken) markers.push({ key: "ghost", label: "표" });
  if (!markers.length) return "";
  return `
    <span class="status-marker-stack" aria-label="상태">
      ${markers.map((marker) => `<span class="status-marker ${marker.key}">${marker.label}</span>`).join("")}
    </span>
  `;
}

function formatMessageTime(time) {
  if (!time) return "";
  return new Date(time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function updateVoteTimers() {
  document.querySelectorAll(".vote-clock[data-deadline]").forEach((clock) => {
    const deadline = Number(clock.dataset.deadline || 0);
    const prepEnd = Number(clock.dataset.prepEnd || 0);
    const inPrep = prepEnd && serverNow() < prepEnd;
    const duration = inPrep
      ? Number(clock.dataset.prepDuration || 3000)
      : Number(clock.dataset.voteDuration || clock.dataset.duration || 15000);
    const target = inPrep ? prepEnd : deadline;
    const leftMs = Math.max(0, target - serverNow());
    const percent = Math.max(0, Math.min(100, (leftMs / duration) * 100));
    clock.style.setProperty("--time-left", `${percent}%`);
    const label = clock.querySelector(".vote-countdown");
    if (label) label.textContent = String(Math.ceil(leftMs / 1000));
  });
}

function topbar(extra = "") {
  return `
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">B</div>
        <div>
          <h1>Blood on the Clocktower</h1>
          <p class="muted small">${escapeHtml(state?.scriptName || "Trouble Brewing")} · ${phaseLabel()}</p>
        </div>
      </div>
      <div class="actions">
        ${extra}
        <span class="status-pill">실시간 연결</span>
      </div>
    </header>
  `;
}

function render() {
  if (!state) {
    app.innerHTML = `<main class="shell">${topbar()}<div class="panel empty">연결 중</div></main>`;
    return;
  }
  if (mode === "host" && state.valid) {
    renderHost();
    return;
  }
  if (mode === "player" && state.valid) {
    renderPlayer();
    return;
  }
  if (mode === "host" && state.valid === false) {
    sessionStorage.removeItem(STORAGE_HOST);
    hostPin = "";
    mode = "public";
  }
  if (mode === "player" && state.valid === false) {
    sessionStorage.removeItem(STORAGE_PLAYER);
    playerAuth = null;
    mode = "public";
  }
  renderLanding();
}

function renderLanding() {
  const urls = (state?.urls || []).map((url) => `<div class="line-item">${escapeHtml(url)}</div>`).join("");
  const count = state?.players?.length || 0;
  const full = count >= maxPlayers();
  const title = lockedScreen === "player" ? "플레이어 화면" : lockedScreen === "host" ? "스토리텔러 화면" : "";
  const playerEntry =
    lockedScreen !== "host"
      ? `
        <form class="panel grid" data-form="join">
          <div class="panel-header">
            <h2>플레이어 입장</h2>
            <span class="tag">${count}/${maxPlayers()}명</span>
          </div>
          <label>
            닉네임
            <input name="name" maxlength="24" autocomplete="nickname" placeholder="예: Alice" required ${full ? "disabled" : ""} />
          </label>
          <button class="primary" type="submit" ${full ? "disabled" : ""}>${full ? "마감" : "참가"}</button>
        </form>
      `
      : "";
  const hostEntry =
    lockedScreen !== "player"
      ? `
        <form class="panel grid" data-form="host-login">
          <div class="panel-header">
            <h2>스토리텔러 입장</h2>
            <span class="tag">암호 필요</span>
          </div>
          <label>
            암호
            <input name="pin" type="password" inputmode="numeric" maxlength="4" autocomplete="off" required />
          </label>
          <button class="green" type="submit">입장</button>
        </form>
      `
      : "";
  app.innerHTML = `
    <main class="shell">
      ${topbar()}
      ${title ? `<section class="mode-strip"><strong>${title}</strong></section>` : ""}
      <section class="landing">
        ${playerEntry}
        ${hostEntry}
      </section>

      <section class="panel grid" style="margin-top:14px">
        <div class="panel-header">
          <h2>접속 주소</h2>
        </div>
        <div class="timeline">${urls || `<div class="empty">주소 확인 중</div>`}</div>
      </section>
    </main>
  `;
}

function renderHost() {
  if (selectedChatPlayerId) markPlayerMessagesRead(selectedChatPlayerId);
  const pendingCount = pendingAbilityRequests().length;
  const unreadCount = sortedPlayers().reduce((total, player) => total + unreadPlayerMessageCount(player.id), 0);
  const hostActions = `
    ${pendingCount ? `<span class="alert-pill">요청 ${pendingCount}</span>` : ""}
    ${unreadCount ? `<span class="alert-pill">메시지 ${unreadCount}</span>` : ""}
    <span class="status-pill storyteller-pill">스토리텔러 · 역할 없음</span>
    <button class="ghost" data-action="logout-host">나가기</button>
  `;
  app.innerHTML = `
    <main class="shell">
      ${topbar(hostActions)}
      <section class="host-dashboard">
        ${hostBoardPanel()}
        <div class="layout">
          <div class="grid">
            ${hostControlPanel()}
            ${hostPlayersPanel()}
            ${hostVotePanel()}
          </div>
          <div class="grid">
            ${hostAbilityPanel()}
            ${hostLogPanel()}
          </div>
        </div>
      </section>
    </main>
  `;
}

function hostBoardPanel() {
  const players = sortedPlayers();
  const active = state.activeVote;
  const tokens = players
    .map((player, index) => {
      const role = player.role;
      const shown = player.shownRole;
      const isDrunkView = role && shown && role.id !== shown.id;
      const position = boardPosition(index, players.length);
      const teamClass = role?.team === "악" ? "evil" : role ? "good" : "unknown";
      const hasCondition = player.poisoned || player.drunk || player.protected;
      const isCurrentVoter = active?.currentVoterId === player.id;
      const isNominee = active?.nomineeId === player.id;
      const isCurrentNight = state.nightProgress?.currentTask?.playerId === player.id;
      const isSelected = selectedChatPlayerId === player.id;
      return `
        <button
          type="button"
          class="board-token ${teamClass} ${player.alive ? "" : "dead"} ${hasCondition ? "has-condition" : ""} ${isSelected ? "selected" : ""} ${isCurrentNight ? "current-night" : ""} ${isCurrentVoter ? "current-voter" : ""} ${isNominee ? "nominee" : ""}"
          style="left:${position.x}%;top:${position.y}%"
          data-action="open-chat"
          data-player-id="${escapeHtml(player.id)}"
          title="${escapeHtml(`${player.seat}. ${player.name} - ${role?.name || "미배정"}`)}"
        >
          <span class="token-seat">${player.seat}</span>
          <span class="token-name">${escapeHtml(player.name)}</span>
          <span class="token-role">${escapeHtml(role?.name || "미배정")}</span>
          ${isDrunkView ? `<span class="token-shown">보임: ${escapeHtml(shown.name)}</span>` : ""}
          ${boardStatusMarkers(player)}
          <span class="token-status-row">${playerStatusTags(player)}</span>
        </button>
      `;
    })
    .join("");
  return `
    <section class="panel board-panel">
      <div class="panel-header">
        <h2>스토리텔러 보드</h2>
        <span class="tag">${players.length}/${maxPlayers()}명</span>
      </div>
      <div class="board-workspace">
        <div class="board-circle">
          <div class="board-rim"></div>
          <div class="clock-hand"></div>
          ${clockNumerals()}
          <div class="board-center">
            <span class="muted small">${escapeHtml(state.scriptName)}</span>
            <strong>${phaseLabel()}</strong>
            ${active ? `<span class="small">투표: ${active.nomineeSeat}. ${escapeHtml(active.nomineeName)}</span>` : `<span class="small">그리모어</span>`}
          </div>
          ${tokens || `<div class="board-empty">플레이어 대기 중</div>`}
        </div>
        <div class="board-side">
          ${hostSelectedPlayerCard()}
          ${hostNightBoardCard()}
        </div>
      </div>
    </section>
  `;
}

function hostSelectedPlayerCard() {
  const selected = ensureSelectedChatPlayer();
  if (!selected) {
    return `
      <div class="board-card selected-panel">
        <div class="panel-header">
          <h2>플레이어 정보</h2>
        </div>
        <div class="empty">보드에서 토큰을 선택하세요.</div>
      </div>
    `;
  }
  const role = selected.role;
  const shown = selected.shownRole;
  const isDrunkView = role && shown && role.id !== shown.id;
  const nightTask = (state.nightTasks || []).find((task) => task.playerId === selected.id);
  const voteTask = state.activeVote?.order?.find((vote) => vote.playerId === selected.id);
  const impBluffs = (selected.impBluffRoles || []).filter(Boolean);
  const impBluffList = impBluffs
    .map((role) => `<span class="token-status">${escapeHtml(role.name)}</span>`)
    .join("");
  const messages = (state.messages?.[selected.id] || [])
    .map(
      (message) => `
        <div class="chat-message">
          <strong>${message.from === "player" ? escapeHtml(selected.name) : "스토리텔러"}</strong>
          <p>${escapeHtml(message.text)}</p>
          <span class="muted small">${formatMessageTime(message.time)}</span>
        </div>
      `,
    )
    .join("");
  const statusTags = playerStatusList(selected)
    .map((status) => `<span class="tag">${escapeHtml(status)}</span>`)
    .join("");
  return `
    <div class="board-card selected-panel">
      <div class="selected-hero">
        <span class="seat big-seat">${selected.seat}</span>
        <div>
          <h2>${escapeHtml(selected.name)}</h2>
          <p class="muted">${escapeHtml(role?.name || "미배정")} ${role?.typeLabel ? `· ${escapeHtml(role.typeLabel)}` : ""}</p>
        </div>
        <span class="tag ${selected.online ? "good" : ""}">${selected.online ? "온라인" : "오프라인"}</span>
        <span class="tag ${role?.team === "악" ? "evil" : role ? "good" : ""}">${escapeHtml(role?.team || "미배정")}</span>
      </div>

      <div class="detail-grid">
        <div>
          <span>실제 역할</span>
          <strong>${escapeHtml(role?.name || "미배정")}</strong>
        </div>
        <div>
          <span>보이는 역할</span>
          <strong>${escapeHtml(shown?.name || "미배정")}</strong>
        </div>
        <div>
          <span>밤 차례</span>
          <strong>${nightTask ? `${nightTask.position}. ${nightStatusText(nightTask.status)}` : "없음"}</strong>
        </div>
        <div>
          <span>투표</span>
          <strong>${voteTask ? voteStatusText(voteTask.status) : "대기"}</strong>
        </div>
      </div>

      <div class="detail-tags">${statusTags}</div>
      ${isDrunkView ? `<div class="notice-line">주정뱅이 처리: 플레이어에게는 ${escapeHtml(shown.name)}로 보입니다.</div>` : ""}
      ${
        impBluffs.length
          ? `<div class="notice-line">임프 블러프: <span class="inline-tags">${impBluffList}</span></div>`
          : ""
      }
      ${role?.summary ? `<p class="selected-summary">${escapeHtml(role.summary)}</p>` : ""}

      <div class="mini-buttons">
        <button class="${selected.alive ? "active" : ""}" data-action="toggle-player" data-player-id="${selected.id}" data-field="alive">생존</button>
        <button class="${selected.voteToken ? "active" : ""}" data-action="toggle-player" data-player-id="${selected.id}" data-field="voteToken">유령표</button>
        <button class="${selected.poisoned ? "active" : ""}" data-action="toggle-player" data-player-id="${selected.id}" data-field="poisoned">중독</button>
        <button class="${selected.drunk ? "active" : ""}" data-action="toggle-player" data-player-id="${selected.id}" data-field="drunk">취함</button>
        <button class="${selected.protected ? "active" : ""}" data-action="toggle-player" data-player-id="${selected.id}" data-field="protected">보호</button>
        <button class="${selected.fortuneTellerRedHerring ? "active" : ""}" data-action="toggle-player" data-player-id="${selected.id}" data-field="fortuneTellerRedHerring">점쟁이 미끼</button>
        <button class="danger" data-action="remove-player" data-player-id="${selected.id}" data-player-name="${escapeHtml(selected.name)}">참가자 제거</button>
      </div>

      <label>
        메모
        <textarea class="note-input" data-player-id="${selected.id}">${escapeHtml(selected.note || "")}</textarea>
      </label>

      <div class="chat-compact">
        <div class="panel-header tight">
          <h3>1:1 메시지</h3>
          <span class="tag">${(state.messages?.[selected.id] || []).length}개</span>
        </div>
        <div class="chat-messages">${messages || `<div class="empty">아직 메시지 없음</div>`}</div>
        <form class="chat-compose" data-form="host-message">
          <input type="hidden" name="playerId" value="${escapeHtml(selected.id)}" />
          <label>
            내용
            <textarea name="message" required></textarea>
          </label>
          <button class="green" type="submit">보내기</button>
        </form>
      </div>
    </div>
  `;
}

function hostControlPanel() {
  const count = state.players.length;
  const canAssign = count >= minPlayers() && count <= maxPlayers();
  const rolesAssigned = state.players.length > 0 && state.players.every((player) => player.role);
  const progress = state.nightProgress || {};
  const currentNight = progress.currentTask;
  const canStartNight = (state.phase === "lobby" || state.phase === "day") && rolesAssigned;
  const canStartDay = state.phase === "night";
  const phaseAction =
    state.phase === "night"
      ? `<button class="green" data-action="start-day" ${canStartDay ? "" : "disabled"}>낮 시작</button>`
      : `<button class="blue" data-action="start-night" ${canStartNight ? "" : "disabled"}>${state.phase === "lobby" ? "첫날밤 시작" : "밤 시작"}</button>`;
  const phaseStatus =
    state.phase === "night"
      ? currentNight
        ? `현재 밤 차례: ${currentNight.playerName} / ${currentNight.role?.name || "역할 없음"}`
        : "밤 차례 완료"
      : state.phase === "day"
        ? "낮 진행 중"
        : rolesAssigned
          ? "첫날밤 대기"
          : "역할 배정 대기";
  const urls = state.urls.map((url) => `<div class="line-item">${escapeHtml(url)}</div>`).join("");
  return `
    <section class="panel grid">
      <div class="panel-header">
        <h2>진행</h2>
        <span class="tag">${count}/${maxPlayers()}명</span>
      </div>
      <div class="actions">
        <span class="tag">${minPlayers()}~${maxPlayers()}명</span>
      </div>
      <div class="actions">
        <button class="primary" data-action="assign" ${canAssign ? "" : "disabled"}>역할 배정</button>
        ${phaseAction}
        <button class="ghost" data-action="reset-game">게임 초기화</button>
        <button class="danger" data-action="reset-all">방 비우기</button>
      </div>
      <div class="phase-status">${escapeHtml(phaseStatus)}</div>
      <div class="timeline">${urls}</div>
    </section>
  `;
}

function hostPlayersPanel() {
  const players = sortedPlayers()
    .map((player) => {
      const role = player.role;
      const shown = player.shownRole;
      const isDrunkView = role && shown && role.id !== shown.id;
      const isSelected = selectedChatPlayerId === player.id;
      const unread = unreadPlayerMessageCount(player.id);
      return `
        <button type="button" class="roster-row ${isSelected ? "selected" : ""} ${player.alive ? "" : "dead"}" data-action="open-chat" data-player-id="${player.id}">
          <span class="seat">${player.seat}</span>
          <span>
            <strong>${escapeHtml(player.name)}</strong>
            <small>${escapeHtml(role?.name || "미배정")}${isDrunkView ? ` · 보임 ${escapeHtml(shown.name)}` : ""}${player.fortuneTellerRedHerring ? " · 점쟁이 미끼" : ""}${unread ? ` · 새 메시지 ${unread}` : ""}${player.online ? "" : " · 오프라인"}</small>
          </span>
          <span class="tag ${role?.team === "악" ? "evil" : role ? "good" : ""}">${escapeHtml(role?.team || "-")}</span>
        </button>
      `;
    })
    .join("");
  return `
    <section class="panel grid">
      <div class="panel-header">
        <h2>플레이어 요약</h2>
      </div>
      <div class="roster-list">${players || `<div class="empty">플레이어 대기 중</div>`}</div>
    </section>
  `;
}

function hostVotePanel() {
  if (state.phase !== "day" && !state.activeVote) {
    return `
      <section class="panel grid">
        <div class="panel-header">
          <h2>투표</h2>
          <span class="tag">낮 전용</span>
        </div>
        <div class="empty">투표와 처형은 낮에만 진행할 수 있어요. 밤에는 능력 순서만 진행하세요.</div>
      </section>
    `;
  }
  const votedTodayIds = new Set((state.voteHistory || []).map((vote) => vote.nomineeId));
  const eligibleNominees = state.players.filter((player) => player.alive && !votedTodayIds.has(player.id));
  const livingOptions = state.players
    .filter((player) => player.alive)
    .map((player) => {
      const used = votedTodayIds.has(player.id);
      const selected = eligibleNominees[0]?.id === player.id;
      return `<option value="${player.id}" ${used ? "disabled" : ""} ${selected ? "selected" : ""}>${player.seat}. ${escapeHtml(player.name)}${used ? " · 오늘 투표 완료" : ""}</option>`;
    })
    .join("");
  const active = state.activeVote;
  const execution = state.execution;
  const voteHistory = state.voteHistory
    .map(
      (vote) => `
        <div class="line-item">
          <strong>${escapeHtml(vote.nomineeName)}</strong>
          <span class="muted">${vote.votes}/${vote.required}</span>
          <span class="tag ${vote.passed ? "good" : ""}">${vote.passed ? "가결" : "부결"}</span>
        </div>
      `,
    )
    .join("");
  const voteBox = active
    ? `
      <div class="vote-box">
        <div class="panel-header">
          <div>
            <h3>${escapeHtml(active.nomineeName)} 투표</h3>
            <p class="muted small">${
              voteStage(active) === "prep"
                ? `준비 중 · 시작 위치: ${active.currentVoterSeat}. ${escapeHtml(active.currentVoterName || "")}`
                : active.currentVoterName
                  ? `시계침 위치: ${active.currentVoterSeat}. ${escapeHtml(active.currentVoterName)}`
                  : "마감 중"
            }</p>
          </div>
          ${voteTimerMarkup(active)}
        </div>
        <div class="progress" style="--value:${Math.min(100, (active.yesCount / Math.max(1, active.required)) * 100)}%">
          <span></span>
        </div>
        <p class="muted">${active.yesCount} / ${active.required}</p>
        <div class="vote-order">
          ${
            (active.order || [])
              .map(
                (vote) => `
                  <div class="vote-step ${vote.status}">
                    <span class="seat">${vote.seat || ""}</span>
                    <strong>${escapeHtml(vote.playerName)}</strong>
                    <span class="tag">${voteStatusText(vote.status)}</span>
                  </div>
                `,
              )
              .join("") || `<div class="empty">투표 순서 없음</div>`
          }
        </div>
        <button class="primary" data-action="close-vote">투표 마감</button>
      </div>
    `
    : `
      <div class="field-row">
        <label>
          지명 대상
          <select id="nominee-select">${livingOptions}</select>
        </label>
        <button class="primary" data-action="start-vote" ${eligibleNominees.length ? "" : "disabled"}>투표 시작</button>
      </div>
      <p class="muted small">지목은 자유롭게 할 수 있지만, 같은 사람을 실제 투표 후보로 올리는 것은 하루 1회만 가능합니다.</p>
    `;
  const executionBox = execution?.candidateName
    ? `<div class="vote-box"><strong>처형 후보: ${escapeHtml(execution.candidateName)}</strong><button class="danger" data-action="execute">처형 처리</button></div>`
    : execution?.tied
      ? `<div class="vote-box"><strong>동점</strong><p class="muted">현재 처형 후보가 없습니다.</p></div>`
      : `<div class="empty">처형 후보 없음</div>`;
  return `
    <section class="panel grid">
      <div class="panel-header">
        <h2>투표</h2>
      </div>
      ${voteBox}
      ${executionBox}
      <div class="timeline">${voteHistory || `<div class="empty">오늘의 투표 기록 없음</div>`}</div>
    </section>
  `;
}

function hostAbilityPanel() {
  const pendingCount = pendingAbilityRequests().length;
  const pendingFirst = [...state.abilityRequests].sort((a, b) => {
    if (a.status === b.status) return b.createdAt - a.createdAt;
    return a.status === "pending" ? -1 : 1;
  });
  const rows = pendingFirst
    .map((request) => {
      const textareaId = `result-${request.id}`;
      const impTransfer = request.impTransferPending
        ? `
          <label>
            새 임프
            <select id="imp-transfer-${request.id}">
              ${request.impTransferOptions
                .map(
                  (player) =>
                    `<option value="${escapeHtml(player.id)}">${player.seat}. ${escapeHtml(player.name)} · ${escapeHtml(player.role?.name || "하수인")}</option>`,
                )
                .join("")}
            </select>
          </label>
        `
        : "";
      const impTransferAction = request.impTransferPending
        ? `<button class="blue" data-action="transfer-imp" data-request-id="${request.id}" data-select-id="imp-transfer-${request.id}" ${request.impTransferOptions.length ? "" : "disabled"}>새 임프 확정</button>`
        : "";
      const closeAction =
        request.status === "pending"
          ? ""
          : `<button class="ghost" data-action="dismiss-request" data-request-id="${request.id}">닫기</button>`;
      return `
        <article class="request ${request.status} ${request.impTransferPending ? "attention" : ""}">
          <div class="panel-header">
            <div>
              <h3>${escapeHtml(request.playerName)} · ${escapeHtml(request.role?.name || "역할 없음")}</h3>
              <p class="muted small">실제 역할: ${escapeHtml(request.actualRole?.name || "미배정")}</p>
            </div>
            <span class="tag">${request.status === "pending" ? "대기" : request.status === "ignored" ? "무시" : "완료"}</span>
          </div>
          <p>대상: ${request.targetNames.map(escapeHtml).join(", ") || "없음"}</p>
          ${request.note ? `<p class="muted">${escapeHtml(request.note)}</p>` : ""}
          <label>
            결과
            <textarea id="${textareaId}">${escapeHtml(request.result || "")}</textarea>
          </label>
          ${impTransfer}
          <div class="actions">
            ${impTransferAction}
            <button class="green" data-action="resolve-request" data-request-id="${request.id}" data-textarea-id="${textareaId}" data-send="true">전달</button>
            <button class="ghost" data-action="resolve-request" data-request-id="${request.id}" data-textarea-id="${textareaId}" data-send="false">수락</button>
            <button class="danger" data-action="ignore-request" data-request-id="${request.id}">무시</button>
            ${closeAction}
          </div>
        </article>
      `;
    })
    .join("");
  return `
    <section class="panel grid">
      <div class="panel-header">
        <h2>능력 요청</h2>
        ${pendingCount ? `<span class="alert-pill">대기 ${pendingCount}</span>` : ""}
      </div>
      ${rows || `<div class="empty">요청 없음</div>`}
    </section>
  `;
}

function hostNightBoardCard() {
  const progress = state.nightProgress || { active: false };
  const current = progress.currentTask;
  const nightLabel = progress.isFirstNight ? "첫날밤" : "매일밤";
  const rows = state.nightTasks
    .map(
      (task) => `
        <div class="night-step ${task.status || "waiting"}">
          <span class="seat">${task.position || task.order}</span>
          <div>
            <strong>${escapeHtml(task.playerName)}</strong>
            <div class="muted">${escapeHtml(task.role?.name || "")}${
            task.actualRole?.id !== task.role?.id ? ` · 실제 ${escapeHtml(task.actualRole?.name || "")}` : ""
          }</div>
          </div>
          <span class="tag">${nightStatusText(task.status)}</span>
        </div>
      `,
    )
    .join("");
  const currentBox = progress.active
    ? current
      ? `
        <div class="night-current">
          <div>
            <span class="tag">${nightLabel}</span>
            <h3>${progress.currentIndex + 1}/${progress.total} · ${escapeHtml(current.playerName)}</h3>
            <p class="muted">${escapeHtml(current.role?.name || "역할 없음")} · 대상 ${current.role?.targetCount || 0}명</p>
          </div>
        </div>
      `
      : `
        <div class="night-current complete">
          <div>
            <span class="tag">${nightLabel}</span>
            <h3>밤 순서 완료</h3>
            <p class="muted">필요한 처리를 마쳤으면 낮을 시작하세요.</p>
          </div>
        </div>
      `
    : `<div class="empty">밤을 시작하면 첫날밤/매일밤 순서가 자동으로 잡혀요.</div>`;
  const controls = progress.active
    ? `
      <div class="actions">
        <button class="ghost" data-action="night-step" data-direction="previous" ${progress.currentIndex <= 0 ? "disabled" : ""}>이전</button>
        <button class="blue" data-action="night-step" data-direction="restart" ${progress.currentIndex <= 0 ? "disabled" : ""}>처음으로</button>
        <button class="green" data-action="night-step" data-direction="next" ${progress.complete ? "disabled" : ""}>다음 차례</button>
      </div>
    `
    : "";
  return `
    <div class="board-card board-night-card">
      <div class="panel-header">
        <h2>밤 순서</h2>
        ${progress.active ? `<span class="tag">${nightLabel}</span>` : ""}
      </div>
      ${currentBox}
      ${controls}
      <div class="timeline">${rows || `<div class="empty">밤 순서 없음</div>`}</div>
    </div>
  `;
}

function hostLogPanel() {
  const rows = state.log
    .map((item) => `<div class="line-item">${escapeHtml(item.message)}</div>`)
    .join("");
  return `
    <section class="panel grid">
      <div class="panel-header">
        <h2>기록</h2>
      </div>
      <div class="timeline">${rows || `<div class="empty">기록 없음</div>`}</div>
    </section>
  `;
}

function renderPlayer() {
  const me = state.me;
  app.innerHTML = `
    <main class="shell">
      ${topbar(`<button class="ghost" data-action="logout-player">나가기</button>`)}
      <section class="layout">
        <div class="grid">
          ${playerRolePanel(me)}
          ${playerVotePanel(me)}
          ${playerAbilityPanel(me)}
        </div>
        <div class="grid">
          ${playerListPanel()}
          ${playerMessagesPanel()}
          ${playerRequestHistory()}
        </div>
      </section>
    </main>
  `;
}

function playerRolePanel(me) {
  const role = me.role;
  if (!role) {
    return `
      <section class="panel grid">
        <div class="panel-header">
          <h2>${escapeHtml(me.name)}</h2>
          <span class="tag">대기</span>
        </div>
        <div class="empty">역할 배정 대기 중</div>
      </section>
    `;
  }
  const impBluffs = (me.impBluffs || []).filter(Boolean);
  const impBluffList = impBluffs
    .map((bluff) => `<span class="token-status">${escapeHtml(bluff.name)}</span>`)
    .join("");
  return `
    <section class="role-card">
      <div class="panel-header">
        <h2>${escapeHtml(me.name)}</h2>
        <span class="tag">${me.alive ? "생존" : "사망"}</span>
      </div>
      <div class="role-name">${escapeHtml(role.name)}</div>
      <div class="role-line">${roleTag(role)}</div>
      <p class="muted">${escapeHtml(role.summary)}</p>
      ${
        impBluffs.length
          ? `<div class="notice-line">이 게임에 없는 마을주민: <span class="inline-tags">${impBluffList}</span></div>`
          : ""
      }
      ${!me.alive ? `<span class="tag ${me.voteToken ? "good" : ""}">유령표 ${me.voteToken ? "있음" : "사용됨"}</span>` : ""}
    </section>
  `;
}

function playerVotePanel(me) {
  const active = state.activeVote;
  if (!active) {
    const message =
      state.phase === "night"
        ? "밤에는 투표가 없습니다. 능력 차례를 기다려 주세요."
        : "진행 중인 투표 없음";
    return `
      <section class="panel grid">
        <div class="panel-header">
          <h2>투표</h2>
          ${state.phase === "night" ? `<span class="tag">낮 전용</span>` : ""}
        </div>
        <div class="empty">${message}</div>
      </section>
    `;
  }
  const eligible = me.alive || me.voteToken;
  const myVote = (active.order || []).find((vote) => vote.playerId === me.id);
  const canVote = eligible && myVote && myVote.yes == null;
  const myChoice = myVote?.choice;
  return `
    <section class="panel grid">
      <div class="panel-header">
        <h2>투표</h2>
        <span class="tag">${active.yesCount}/${active.required}</span>
      </div>
      <div class="vote-box">
        <div class="panel-header">
          <div>
            <h3>${escapeHtml(active.nomineeName)}</h3>
            <p class="muted small">${
              myVote?.yes != null
                ? `내 투표 확정: ${voteStatusText(myVote.status)}`
                : canVote
                  ? "미리 찬성/반대를 눌러둘 수 있어요"
                  : active.currentVoterName
                    ? `시계침 위치: ${active.currentVoterSeat}. ${escapeHtml(active.currentVoterName)}`
                    : "마감 중"
            }</p>
          </div>
          ${voteTimerMarkup(active)}
        </div>
        <div class="progress" style="--value:${Math.min(100, (active.yesCount / Math.max(1, active.required)) * 100)}%">
          <span></span>
        </div>
        <div class="actions">
          <button class="primary ${myChoice === true ? "active" : ""}" data-action="player-vote" data-yes="true" ${canVote ? "" : "disabled"}>찬성</button>
          <button class="ghost ${myChoice === false ? "active" : ""}" data-action="player-vote" data-yes="false" ${canVote ? "" : "disabled"}>반대</button>
        </div>
        <div class="timeline">
          ${(active.order || [])
            .map(
              (vote) => `
                <div class="line-item">
                  <strong>${vote.seat || ""}. ${escapeHtml(vote.playerName)}</strong>
                  <span class="tag">${voteStatusText(vote.status)}</span>
                </div>
              `,
            )
            .join("")}
        </div>
      </div>
    </section>
  `;
}

function playerAbilityPanel(me) {
  const role = me.role;
  if (!role) {
    return "";
  }
  const nightTurn = state.nightTurn || { active: false };
  const isNight = state.phase === "night" && nightTurn.active;
  const hasPendingRequest = (state.abilityRequests || []).some((request) => request.status === "pending");
  const isLobby = state.phase === "lobby";
  const isImpFirstNightInfo = role.id === "imp" && isNight && nightTurn.isMine && nightTurn.isFirstNight;
  const canRequest = isNight && !isImpFirstNightInfo && nightTurn.isMine && !hasPendingRequest;
  const nightMessage = isNight
    ? nightTurn.complete
      ? "밤 순서가 끝났어요. 스토리텔러가 낮을 시작할 때까지 기다려 주세요."
      : nightTurn.isMine
        ? isImpFirstNightInfo
          ? "첫날밤에는 공격하지 않고 블러프 3개를 확인해요."
          : "지금 당신의 밤 차례예요."
        : "아직 당신의 밤 차례가 아니에요."
    : "";
  const phaseMessage = isLobby
    ? "게임이 시작되기 전에는 능력 요청을 보낼 수 없어요."
    : state.phase === "day"
      ? "낮에는 능력 요청을 보낼 수 없어요. 스토리텔러에게는 메시지를 보내세요."
      : "";
  const pendingMessage = hasPendingRequest ? "이전 요청을 스토리텔러가 처리할 때까지 새 요청을 보낼 수 없어요." : "";
  const impBluffs = (me.impBluffs || []).filter(Boolean);
  const impBluffList = impBluffs
    .map((bluff) => `<span class="token-status">${escapeHtml(bluff.name)}</span>`)
    .join("");
  const targetFields = Array.from({ length: role.targetCount }, (_, index) => {
    const options = state.players
      .map((player) => `<option value="${player.id}">${player.seat}. ${escapeHtml(player.name)}</option>`)
      .join("");
    return `
      <label>
        대상 ${index + 1}
        <select name="target" ${canRequest ? "" : "disabled"}>${options}</select>
      </label>
    `;
  }).join("");
  return `
    <form class="panel grid" data-form="ability">
      <div class="panel-header">
        <h2>능력</h2>
        <span class="tag ${isNight && nightTurn.isMine ? "good" : ""}">${isNight && nightTurn.isMine ? "내 차례" : escapeHtml(role.name)}</span>
      </div>
      ${nightMessage ? `<div class="night-hint ${nightTurn.isMine ? "active" : ""}">${escapeHtml(nightMessage)}</div>` : ""}
      ${phaseMessage ? `<div class="night-hint">${escapeHtml(phaseMessage)}</div>` : ""}
      ${pendingMessage ? `<div class="night-hint">${escapeHtml(pendingMessage)}</div>` : ""}
      ${
        isImpFirstNightInfo
          ? `<div class="notice-line">이 게임에 없는 마을주민: <span class="inline-tags">${impBluffList || "확인 중"}</span></div>`
          : `
            ${targetFields}
            <label>
              메모
              <textarea name="note" ${canRequest ? "" : "disabled"}></textarea>
            </label>
            <button class="green" type="submit" ${canRequest ? "" : "disabled"}>요청</button>
          `
      }
    </form>
  `;
}

function playerListPanel() {
  const rows = state.players
    .map(
      (player) => `
        <div class="line-item">
          <strong>${player.seat}. ${escapeHtml(player.name)}</strong>
          <span class="tag">${player.alive ? "생존" : "사망"}</span>
          ${!player.alive ? `<span class="tag">${player.voteToken ? "유령표 있음" : "유령표 사용"}</span>` : ""}
        </div>
      `,
    )
    .join("");
  return `
    <section class="panel grid">
      <div class="panel-header">
        <h2>플레이어</h2>
      </div>
      <div class="timeline">${rows || `<div class="empty">플레이어 없음</div>`}</div>
    </section>
  `;
}

function playerMessagesPanel() {
  const rows = state.messages
    .map(
      (message) => `
        <div class="line-item">
          <strong>${message.from === "player" ? "나" : "스토리텔러"}</strong>
          <div>${escapeHtml(message.text)}</div>
          <span class="muted small">${formatMessageTime(message.time)}</span>
        </div>
      `,
    )
    .join("");
  return `
    <section class="panel grid">
      <div class="panel-header">
        <h2>비밀 메시지</h2>
      </div>
      <div class="timeline">${rows || `<div class="empty">메시지 없음</div>`}</div>
      <form class="chat-compose" data-form="player-message">
        <label>
          스토리텔러에게
          <textarea name="message" required></textarea>
        </label>
        <button class="green" type="submit">보내기</button>
      </form>
    </section>
  `;
}

function playerRequestHistory() {
  const rows = state.abilityRequests
    .map(
      (request) => `
        <div class="line-item">
          <strong>${escapeHtml(request.role?.name || "능력")}</strong>
          <span class="tag">${request.status === "pending" ? "대기" : request.status === "ignored" ? "무시" : "완료"}</span>
          <div class="muted">${request.targetNames.map(escapeHtml).join(", ") || "대상 없음"}</div>
          ${request.result ? `<div>${escapeHtml(request.result)}</div>` : ""}
        </div>
      `,
    )
    .join("");
  return `
    <section class="panel grid">
      <div class="panel-header">
        <h2>요청 기록</h2>
      </div>
      <div class="timeline">${rows || `<div class="empty">요청 없음</div>`}</div>
    </section>
  `;
}

document.addEventListener("submit", async (event) => {
  const form = event.target;
  const formType = form.dataset.form;
  if (!formType) return;
  event.preventDefault();
  const data = new FormData(form);
  try {
    if (formType === "join") {
      const result = await api("/api/join", { name: data.get("name") });
      playerAuth = result;
      sessionStorage.setItem(STORAGE_PLAYER, JSON.stringify(playerAuth));
      connect("player");
      return;
    }
    if (formType === "host-login") {
      const pin = String(data.get("pin") || "").trim();
      await api("/api/host/login", { pin });
      hostPin = pin;
      connect("host");
      return;
    }
    if (formType === "host-message") {
      await api("/api/host/message", {
        pin: hostPin,
        playerId: data.get("playerId"),
        message: data.get("message"),
      });
      form.reset();
      return;
    }
    if (formType === "player-message") {
      await api("/api/message", {
        playerId: playerAuth.playerId,
        secret: playerAuth.secret,
        message: data.get("message"),
      });
      form.reset();
      return;
    }
    if (formType === "ability") {
      const targetIds = [...form.querySelectorAll('select[name="target"]')].map((select) => select.value);
      await api("/api/ability", {
        playerId: playerAuth.playerId,
        secret: playerAuth.secret,
        targetIds,
        note: data.get("note"),
      });
      form.reset();
      return;
    }
  } catch (error) {
    showToast(error.message);
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === "logout-host") {
      sessionStorage.removeItem(STORAGE_HOST);
      hostPin = "";
      connect("public");
      return;
    }
    if (action === "logout-player") {
      if (playerAuth?.playerId && playerAuth?.secret) {
        await api("/api/leave", {
          playerId: playerAuth.playerId,
          secret: playerAuth.secret,
        });
      }
      sessionStorage.removeItem(STORAGE_PLAYER);
      playerAuth = null;
      connect("public");
      return;
    }
    if (action === "open-chat") {
      selectedChatPlayerId = button.dataset.playerId;
      render();
      return;
    }
    if (action === "assign") await api("/api/host/assign", { pin: hostPin });
    if (action === "start-night") await api("/api/host/start-night", { pin: hostPin });
    if (action === "night-step") await api("/api/host/night-step", { pin: hostPin, direction: button.dataset.direction });
    if (action === "start-day") await api("/api/host/start-day", { pin: hostPin });
    if (action === "reset-game") await api("/api/host/reset-game", { pin: hostPin });
    if (action === "reset-all") await api("/api/host/reset-all", { pin: hostPin });
    if (action === "toggle-player") {
      await api("/api/host/toggle-player", {
        pin: hostPin,
        playerId: button.dataset.playerId,
        field: button.dataset.field,
      });
    }
    if (action === "remove-player") {
      const name = button.dataset.playerName || "이 플레이어";
      if (!window.confirm(`${name} 님을 플레이어 목록에서 제거할까요?`)) return;
      await api("/api/host/remove-player", {
        pin: hostPin,
        playerId: button.dataset.playerId,
      });
      selectedChatPlayerId = null;
    }
    if (action === "start-vote") {
      const nomineeId = document.querySelector("#nominee-select")?.value;
      await api("/api/host/start-vote", { pin: hostPin, nomineeId });
    }
    if (action === "close-vote") await api("/api/host/close-vote", { pin: hostPin });
    if (action === "transfer-imp") {
      const select = document.getElementById(button.dataset.selectId);
      await api("/api/host/transfer-imp", {
        pin: hostPin,
        requestId: button.dataset.requestId,
        playerId: select?.value,
      });
    }
    if (action === "execute") await api("/api/host/execute", { pin: hostPin });
    if (action === "player-vote") {
      await api("/api/vote", {
        playerId: playerAuth.playerId,
        secret: playerAuth.secret,
        yes: button.dataset.yes === "true",
      });
    }
    if (action === "resolve-request") {
      const textarea = document.getElementById(button.dataset.textareaId);
      await api("/api/host/resolve-request", {
        pin: hostPin,
        requestId: button.dataset.requestId,
        result: textarea?.value || "",
        sendToPlayer: button.dataset.send === "true",
      });
    }
    if (action === "ignore-request") {
      await api("/api/host/resolve-request", {
        pin: hostPin,
        requestId: button.dataset.requestId,
        ignored: true,
        sendToPlayer: false,
      });
    }
    if (action === "dismiss-request") {
      await api("/api/host/dismiss-request", {
        pin: hostPin,
        requestId: button.dataset.requestId,
      });
    }
  } catch (error) {
    showToast(error.message);
  }
});

document.addEventListener("change", async (event) => {
  const note = event.target.closest(".note-input");
  if (!note) return;
  try {
    await api("/api/host/note", {
      pin: hostPin,
      playerId: note.dataset.playerId,
      note: note.value,
    });
  } catch (error) {
    showToast(error.message);
  }
});

if (playerAuth) {
  connect("player");
} else {
  connect("public");
}

setInterval(updateVoteTimers, 200);
