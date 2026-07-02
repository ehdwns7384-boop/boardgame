const STORAGE_HOST = "botcHelperHostPin";
const STORAGE_PLAYER = "botcHelperPlayer";

let mode = "public";
let hostPin = localStorage.getItem(STORAGE_HOST) || "";
let playerAuth = readPlayerAuth();
let state = null;
let events = null;
let toastTimer = null;
let serverOffsetMs = 0;
let selectedChatPlayerId = null;

const app = document.querySelector("#app");

function readPlayerAuth() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_PLAYER) || "null");
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
  let url = `/events?mode=${encodeURIComponent(mode)}`;
  if (mode === "host") {
    url += `&pin=${encodeURIComponent(hostPin)}`;
  }
  if (mode === "player" && playerAuth) {
    url += `&playerId=${encodeURIComponent(playerAuth.playerId)}&secret=${encodeURIComponent(playerAuth.secret)}`;
  }
  events = new EventSource(url);
  events.addEventListener("state", (event) => {
    state = JSON.parse(event.data);
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
  const selected = players.find((player) => player.id === selectedChatPlayerId) || players[0];
  selectedChatPlayerId = selected.id;
  return selected;
}

function boardPosition(index, count) {
  const angle = -90 + (index * 360) / Math.max(1, count);
  const radians = (angle * Math.PI) / 180;
  const radius = count > 12 ? 39 : 38;
  return {
    x: 50 + Math.cos(radians) * radius,
    y: 50 + Math.sin(radians) * radius,
  };
}

function playerStatusTags(player) {
  const statuses = [player.alive ? "생존" : "사망"];
  if (!player.alive && player.voteToken) statuses.push("유령표");
  if (player.poisoned) statuses.push("중독");
  if (player.drunk) statuses.push("취함");
  if (player.protected) statuses.push("보호");
  return statuses.map((status) => `<span class="token-status">${status}</span>`).join("");
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
          <h1>블클타 도우미</h1>
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
    localStorage.removeItem(STORAGE_HOST);
    hostPin = "";
    mode = "public";
  }
  if (mode === "player" && state.valid === false) {
    localStorage.removeItem(STORAGE_PLAYER);
    playerAuth = null;
    mode = "public";
  }
  renderLanding();
}

function renderLanding() {
  const urls = (state?.urls || []).map((url) => `<div class="line-item">${escapeHtml(url)}</div>`).join("");
  const count = state?.players?.length || 0;
  const full = count >= maxPlayers();
  app.innerHTML = `
    <main class="shell">
      ${topbar()}
      <section class="landing">
        <form class="panel grid" data-form="join">
          <div class="panel-header">
            <h2>플레이어 참가</h2>
            <span class="tag">${count}/${maxPlayers()}명</span>
          </div>
          <label>
            닉네임
            <input name="name" maxlength="24" autocomplete="nickname" required ${full ? "disabled" : ""} />
          </label>
          <button class="primary" type="submit" ${full ? "disabled" : ""}>${full ? "마감" : "참가"}</button>
        </form>

        <form class="panel grid" data-form="host-login">
          <div class="panel-header">
            <h2>스토리텔러</h2>
          </div>
          <label>
            PIN
            <input name="pin" inputmode="numeric" maxlength="6" required />
          </label>
          <button class="green" type="submit">입장</button>
        </form>
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
  ensureSelectedChatPlayer();
  app.innerHTML = `
    <main class="shell">
      ${topbar(`<button class="ghost" data-action="logout-host">나가기</button>`)}
      <section class="layout">
        <div class="grid">
          ${hostBoardPanel()}
          ${hostControlPanel()}
          ${hostPlayersPanel()}
          ${hostVotePanel()}
        </div>
        <div class="grid">
          ${hostAbilityPanel()}
          ${hostMessagePanel()}
          ${hostNightPanel()}
          ${hostLogPanel()}
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
      const isCurrentVoter = active?.currentVoterId === player.id;
      const isNominee = active?.nomineeId === player.id;
      const isCurrentNight = state.nightProgress?.currentTask?.playerId === player.id;
      const isSelected = selectedChatPlayerId === player.id;
      return `
        <button
          type="button"
          class="board-token ${teamClass} ${player.alive ? "" : "dead"} ${isSelected ? "selected" : ""} ${isCurrentNight ? "current-night" : ""} ${isCurrentVoter ? "current-voter" : ""} ${isNominee ? "nominee" : ""}"
          style="left:${position.x}%;top:${position.y}%"
          data-action="open-chat"
          data-player-id="${escapeHtml(player.id)}"
          title="${escapeHtml(`${player.seat}. ${player.name} - ${role?.name || "미배정"}`)}"
        >
          <span class="token-seat">${player.seat}</span>
          <span class="token-name">${escapeHtml(player.name)}</span>
          <span class="token-role">${escapeHtml(role?.name || "미배정")}</span>
          ${isDrunkView ? `<span class="token-shown">보임: ${escapeHtml(shown.name)}</span>` : ""}
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
      <div class="board-circle">
        <div class="board-rim"></div>
        <div class="board-center">
          <span class="muted small">${escapeHtml(state.scriptName)}</span>
          <strong>${phaseLabel()}</strong>
          ${active ? `<span class="small">투표: ${active.nomineeSeat}. ${escapeHtml(active.nomineeName)}</span>` : `<span class="small">그리모어</span>`}
        </div>
        ${tokens || `<div class="board-empty">플레이어 대기 중</div>`}
      </div>
    </section>
  `;
}

function hostControlPanel() {
  const count = state.players.length;
  const canAssign = count >= minPlayers() && count <= maxPlayers();
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
        <button class="blue" data-action="start-night">밤 시작</button>
        <button class="green" data-action="start-day">낮 시작</button>
        <button class="ghost" data-action="reset-game">게임 초기화</button>
        <button class="danger" data-action="reset-all">방 비우기</button>
      </div>
      <div class="timeline">${urls}</div>
    </section>
  `;
}

function hostPlayersPanel() {
  const players = state.players
    .map((player) => {
      const role = player.role;
      const shown = player.shownRole;
      const isDrunkView = role && shown && role.id !== shown.id;
      return `
        <article class="player-card ${player.alive ? "" : "dead"}">
          <div class="player-head">
            <div class="name-line">
              <span class="seat">${player.seat}</span>
              <strong>${escapeHtml(player.name)}</strong>
            </div>
            <span class="tag">${player.alive ? "생존" : "사망"}</span>
          </div>
          <div class="role-line">
            <strong>${escapeHtml(role?.name || "미배정")}</strong>
            ${roleTag(role)}
            ${
              isDrunkView
                ? `<span class="tag">보이는 역할: ${escapeHtml(shown.name)}</span>`
                : ""
            }
          </div>
          <div class="mini-buttons">
            <button class="${player.alive ? "active" : ""}" data-action="toggle-player" data-player-id="${player.id}" data-field="alive">생존</button>
            <button class="${player.voteToken ? "active" : ""}" data-action="toggle-player" data-player-id="${player.id}" data-field="voteToken">유령표</button>
            <button class="${player.poisoned ? "active" : ""}" data-action="toggle-player" data-player-id="${player.id}" data-field="poisoned">중독</button>
            <button class="${player.drunk ? "active" : ""}" data-action="toggle-player" data-player-id="${player.id}" data-field="drunk">취함</button>
            <button class="${player.protected ? "active" : ""}" data-action="toggle-player" data-player-id="${player.id}" data-field="protected">보호</button>
          </div>
          <label>
            메모
            <textarea class="note-input" data-player-id="${player.id}">${escapeHtml(player.note || "")}</textarea>
          </label>
        </article>
      `;
    })
    .join("");
  return `
    <section class="panel grid">
      <div class="panel-header">
        <h2>그리모어</h2>
      </div>
      <div class="player-list">${players || `<div class="empty">플레이어 대기 중</div>`}</div>
    </section>
  `;
}

function hostVotePanel() {
  const livingOptions = state.players
    .filter((player) => player.alive)
    .map((player) => `<option value="${player.id}">${player.seat}. ${escapeHtml(player.name)}</option>`)
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
        <button class="primary" data-action="start-vote" ${livingOptions ? "" : "disabled"}>투표 시작</button>
      </div>
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
  const pendingFirst = [...state.abilityRequests].sort((a, b) => {
    if (a.status === b.status) return b.createdAt - a.createdAt;
    return a.status === "pending" ? -1 : 1;
  });
  const rows = pendingFirst
    .map((request) => {
      const textareaId = `result-${request.id}`;
      return `
        <article class="request ${request.status}">
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
          <div class="actions">
            <button class="green" data-action="resolve-request" data-request-id="${request.id}" data-textarea-id="${textareaId}" data-send="true">전달</button>
            <button class="ghost" data-action="resolve-request" data-request-id="${request.id}" data-textarea-id="${textareaId}" data-send="false">저장</button>
            <button class="danger" data-action="ignore-request" data-request-id="${request.id}">무시</button>
          </div>
        </article>
      `;
    })
    .join("");
  return `
    <section class="panel grid">
      <div class="panel-header">
        <h2>능력 요청</h2>
      </div>
      ${rows || `<div class="empty">요청 없음</div>`}
    </section>
  `;
}

function hostMessagePanel() {
  const selected = ensureSelectedChatPlayer();
  if (!selected) {
    return `
      <section class="panel chat-panel">
        <div class="panel-header">
          <h2>1:1 대화</h2>
        </div>
        <div class="empty">플레이어 대기 중</div>
      </section>
    `;
  }
  const messages = (state.messages?.[selected.id] || [])
    .map(
      (message) => `
        <div class="chat-message">
          <p>${escapeHtml(message.text)}</p>
          <span class="muted small">${formatMessageTime(message.time)}</span>
        </div>
      `,
    )
    .join("");
  return `
    <section class="panel chat-panel">
      <div class="panel-header">
        <div>
          <h2>1:1 대화</h2>
          <p class="muted small">${selected.seat}. ${escapeHtml(selected.name)} · ${escapeHtml(selected.role?.name || "미배정")}</p>
        </div>
        <span class="tag">${selected.alive ? "생존" : "사망"}</span>
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
    </section>
  `;
}

function hostNightPanel() {
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
    <section class="panel grid">
      <div class="panel-header">
        <h2>밤 순서</h2>
        ${progress.active ? `<span class="tag">${nightLabel}</span>` : ""}
      </div>
      ${currentBox}
      ${controls}
      <div class="timeline">${rows || `<div class="empty">밤 순서 없음</div>`}</div>
    </section>
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
  return `
    <section class="role-card">
      <div class="panel-header">
        <h2>${escapeHtml(me.name)}</h2>
        <span class="tag">${me.alive ? "생존" : "사망"}</span>
      </div>
      <div class="role-name">${escapeHtml(role.name)}</div>
      <div class="role-line">${roleTag(role)}</div>
      <p class="muted">${escapeHtml(role.summary)}</p>
      ${!me.alive ? `<span class="tag ${me.voteToken ? "good" : ""}">유령표 ${me.voteToken ? "있음" : "사용됨"}</span>` : ""}
    </section>
  `;
}

function playerVotePanel(me) {
  const active = state.activeVote;
  if (!active) {
    return `
      <section class="panel grid">
        <div class="panel-header">
          <h2>투표</h2>
        </div>
        <div class="empty">진행 중인 투표 없음</div>
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
  const canRequest = !isNight || nightTurn.isMine;
  const nightMessage = isNight
    ? nightTurn.complete
      ? "밤 순서가 끝났어요. 스토리텔러가 낮을 시작할 때까지 기다려 주세요."
      : nightTurn.isMine
        ? "지금 당신의 밤 차례예요."
        : "아직 당신의 밤 차례가 아니에요."
    : "";
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
      ${targetFields}
      <label>
        메모
        <textarea name="note" ${canRequest ? "" : "disabled"}></textarea>
      </label>
      <button class="green" type="submit" ${canRequest ? "" : "disabled"}>요청</button>
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
    .map((message) => `<div class="line-item">${escapeHtml(message.text)}</div>`)
    .join("");
  return `
    <section class="panel grid">
      <div class="panel-header">
        <h2>비밀 메시지</h2>
      </div>
      <div class="timeline">${rows || `<div class="empty">메시지 없음</div>`}</div>
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
      localStorage.setItem(STORAGE_PLAYER, JSON.stringify(playerAuth));
      connect("player");
      return;
    }
    if (formType === "host-login") {
      hostPin = String(data.get("pin") || "").trim();
      localStorage.setItem(STORAGE_HOST, hostPin);
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
      localStorage.removeItem(STORAGE_HOST);
      hostPin = "";
      connect("public");
      return;
    }
    if (action === "logout-player") {
      localStorage.removeItem(STORAGE_PLAYER);
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
    if (action === "start-vote") {
      const nomineeId = document.querySelector("#nominee-select")?.value;
      await api("/api/host/start-vote", { pin: hostPin, nomineeId });
    }
    if (action === "close-vote") await api("/api/host/close-vote", { pin: hostPin });
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

if (hostPin) {
  connect("host");
} else if (playerAuth) {
  connect("player");
} else {
  connect("public");
}

setInterval(updateVoteTimers, 200);
