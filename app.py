import json
import mimetypes
import os
import queue
import random
import secrets
import socket
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
PORT = int(os.environ.get("BOTC_PORT", "8000"))
HOST_PIN = os.environ.get("BOTC_HOST_PIN") or "0123"
MIN_PLAYERS = 5
MAX_PLAYERS = 15
VOTE_PREP_MS = 3000
VOTE_DURATION_MS = 15000


ROLE_TYPES = {
    "townsfolk": "마을주민",
    "outsider": "외부인",
    "minion": "하수인",
    "demon": "악마",
}

SETUP_COUNTS = {
    5: {"townsfolk": 3, "outsider": 0, "minion": 1, "demon": 1},
    6: {"townsfolk": 3, "outsider": 1, "minion": 1, "demon": 1},
    7: {"townsfolk": 5, "outsider": 0, "minion": 1, "demon": 1},
    8: {"townsfolk": 5, "outsider": 1, "minion": 1, "demon": 1},
    9: {"townsfolk": 5, "outsider": 2, "minion": 1, "demon": 1},
    10: {"townsfolk": 7, "outsider": 0, "minion": 2, "demon": 1},
    11: {"townsfolk": 7, "outsider": 1, "minion": 2, "demon": 1},
    12: {"townsfolk": 7, "outsider": 2, "minion": 2, "demon": 1},
    13: {"townsfolk": 9, "outsider": 0, "minion": 3, "demon": 1},
    14: {"townsfolk": 9, "outsider": 1, "minion": 3, "demon": 1},
    15: {"townsfolk": 9, "outsider": 2, "minion": 3, "demon": 1},
}


ROLE_CATALOG = [
    {
        "id": "washerwoman",
        "name": "세탁부",
        "type": "townsfolk",
        "team": "선",
        "targetCount": 2,
        "firstNight": True,
        "otherNight": False,
        "firstOrder": 2,
        "otherOrder": 0,
        "summary": "두 명 중 한 명이 특정 마을주민이라고 알림.",
    },
    {
        "id": "librarian",
        "name": "사서",
        "type": "townsfolk",
        "team": "선",
        "targetCount": 2,
        "firstNight": True,
        "otherNight": False,
        "firstOrder": 3,
        "otherOrder": 0,
        "summary": "두 명 중 한 명이 특정 외부인이라고 알림.",
    },
    {
        "id": "investigator",
        "name": "조사관",
        "type": "townsfolk",
        "team": "선",
        "targetCount": 2,
        "firstNight": True,
        "otherNight": False,
        "firstOrder": 4,
        "otherOrder": 0,
        "summary": "두 명 중 한 명이 특정 하수인이라고 알림.",
    },
    {
        "id": "chef",
        "name": "요리사",
        "type": "townsfolk",
        "team": "선",
        "targetCount": 0,
        "firstNight": True,
        "otherNight": False,
        "firstOrder": 5,
        "otherOrder": 0,
        "summary": "붙어 앉은 악 플레이어 쌍의 수를 알림.",
    },
    {
        "id": "empath",
        "name": "공감능력자",
        "type": "townsfolk",
        "team": "선",
        "targetCount": 0,
        "firstNight": True,
        "otherNight": True,
        "firstOrder": 6,
        "otherOrder": 6,
        "summary": "양옆 생존자 중 악 플레이어 수를 알림.",
    },
    {
        "id": "fortune_teller",
        "name": "점쟁이",
        "type": "townsfolk",
        "team": "선",
        "targetCount": 2,
        "firstNight": True,
        "otherNight": True,
        "firstOrder": 7,
        "otherOrder": 7,
        "summary": "선택한 두 명 중 악마가 있는지 알림.",
    },
    {
        "id": "undertaker",
        "name": "장의사",
        "type": "townsfolk",
        "team": "선",
        "targetCount": 0,
        "firstNight": False,
        "otherNight": True,
        "firstOrder": 0,
        "otherOrder": 5,
        "summary": "전날 처형된 플레이어의 역할을 확인.",
    },
    {
        "id": "monk",
        "name": "수도승",
        "type": "townsfolk",
        "team": "선",
        "targetCount": 1,
        "firstNight": False,
        "otherNight": True,
        "firstOrder": 0,
        "otherOrder": 2,
        "summary": "한 명을 밤의 악마 공격으로부터 보호.",
    },
    {
        "id": "ravenkeeper",
        "name": "레이븐키퍼",
        "type": "townsfolk",
        "team": "선",
        "targetCount": 1,
        "firstNight": False,
        "otherNight": False,
        "firstOrder": 0,
        "otherOrder": 4,
        "summary": "밤에 죽으면 한 명의 역할을 확인.",
    },
    {
        "id": "virgin",
        "name": "처녀",
        "type": "townsfolk",
        "team": "선",
        "targetCount": 0,
        "firstNight": False,
        "otherNight": False,
        "firstOrder": 0,
        "otherOrder": 0,
        "summary": "처음 지명한 마을주민을 즉시 처형.",
    },
    {
        "id": "slayer",
        "name": "슬레이어",
        "type": "townsfolk",
        "team": "선",
        "targetCount": 1,
        "firstNight": False,
        "otherNight": False,
        "firstOrder": 0,
        "otherOrder": 0,
        "summary": "게임 중 한 번 악마라고 생각하는 한 명을 쏨.",
    },
    {
        "id": "soldier",
        "name": "군인",
        "type": "townsfolk",
        "team": "선",
        "targetCount": 0,
        "firstNight": False,
        "otherNight": False,
        "firstOrder": 0,
        "otherOrder": 0,
        "summary": "악마의 공격으로 죽지 않음.",
    },
    {
        "id": "mayor",
        "name": "시장",
        "type": "townsfolk",
        "team": "선",
        "targetCount": 0,
        "firstNight": False,
        "otherNight": False,
        "firstOrder": 0,
        "otherOrder": 0,
        "summary": "특정 조건으로 선 팀 승리를 유도.",
    },
    {
        "id": "butler",
        "name": "집사",
        "type": "outsider",
        "team": "선",
        "targetCount": 1,
        "firstNight": True,
        "otherNight": True,
        "firstOrder": 8,
        "otherOrder": 8,
        "summary": "주인을 고르고 그 사람과 함께 투표.",
    },
    {
        "id": "drunk",
        "name": "주정뱅이",
        "type": "outsider",
        "team": "선",
        "targetCount": 0,
        "firstNight": False,
        "otherNight": False,
        "firstOrder": 0,
        "otherOrder": 0,
        "summary": "자신이 다른 마을주민이라고 믿음.",
    },
    {
        "id": "recluse",
        "name": "은둔자",
        "type": "outsider",
        "team": "선",
        "targetCount": 0,
        "firstNight": False,
        "otherNight": False,
        "firstOrder": 0,
        "otherOrder": 0,
        "summary": "악 팀으로 보일 수 있음.",
    },
    {
        "id": "saint",
        "name": "성자",
        "type": "outsider",
        "team": "선",
        "targetCount": 0,
        "firstNight": False,
        "otherNight": False,
        "firstOrder": 0,
        "otherOrder": 0,
        "summary": "처형되면 선 팀이 패배.",
    },
    {
        "id": "poisoner",
        "name": "독살자",
        "type": "minion",
        "team": "악",
        "targetCount": 1,
        "firstNight": True,
        "otherNight": True,
        "firstOrder": 1,
        "otherOrder": 1,
        "summary": "한 명을 중독시켜 능력을 망가뜨림.",
    },
    {
        "id": "spy",
        "name": "스파이",
        "type": "minion",
        "team": "악",
        "targetCount": 0,
        "firstNight": True,
        "otherNight": True,
        "firstOrder": 9,
        "otherOrder": 9,
        "summary": "그리모어를 확인하고 선 팀으로 보일 수 있음.",
    },
    {
        "id": "baron",
        "name": "남작",
        "type": "minion",
        "team": "악",
        "targetCount": 0,
        "firstNight": False,
        "otherNight": False,
        "firstOrder": 0,
        "otherOrder": 0,
        "summary": "외부인이 늘어나도록 게임 구성을 바꿈.",
    },
    {
        "id": "scarlet_woman",
        "name": "스칼렛 우먼",
        "type": "minion",
        "team": "악",
        "targetCount": 0,
        "firstNight": False,
        "otherNight": False,
        "firstOrder": 0,
        "otherOrder": 0,
        "summary": "특정 상황에서 새 악마가 됨.",
    },
    {
        "id": "imp",
        "name": "임프",
        "type": "demon",
        "team": "악",
        "targetCount": 1,
        "firstNight": True,
        "otherNight": True,
        "firstOrder": 10,
        "otherOrder": 99,
        "summary": "밤마다 한 명을 공격.",
    },
]

ROLE_BY_ID = {role["id"]: role for role in ROLE_CATALOG}


def now_ms():
    return int(time.time() * 1000)


def clean_name(name):
    value = str(name or "").strip()
    return value[:24]


def role_public(role_id):
    if not role_id:
        return None
    role = ROLE_BY_ID.get(role_id)
    if not role:
        return None
    return {
        "id": role["id"],
        "name": role["name"],
        "type": role["type"],
        "typeLabel": ROLE_TYPES[role["type"]],
        "team": role["team"],
        "targetCount": role["targetCount"],
        "firstNight": role["firstNight"],
        "otherNight": role["otherNight"],
        "summary": role["summary"],
    }


def get_lan_urls():
    urls = [f"http://localhost:{PORT}"]
    found = set()
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if ip and not ip.startswith("127."):
                found.add(ip)
    except OSError:
        pass
    for ip in sorted(found):
        urls.append(f"http://{ip}:{PORT}")
    return urls


class GameStore:
    def __init__(self):
        self.lock = threading.RLock()
        self.clients = []
        self.reset_everything()

    def reset_everything(self):
        with self.lock:
            self.state = {
                "scriptName": "Trouble Brewing",
                "phase": "lobby",
                "day": 0,
                "night": 0,
                "players": [],
                "activeVote": None,
                "voteHistory": [],
                "execution": {"candidateId": None, "topVotes": 0, "tied": False},
                "abilityRequests": [],
                "nightProgress": None,
                "impBluffsAssigned": False,
                "messages": {},
                "log": [],
                "updatedAt": now_ms(),
            }
            self._log("새 방이 준비되었습니다.")
        self.broadcast()

    def reset_game_keep_players(self):
        with self.lock:
            for player in self.state["players"]:
                player.update(
                    {
                        "alive": True,
                        "voteToken": True,
                        "roleId": None,
                        "shownRoleId": None,
                        "poisoned": False,
                        "drunk": False,
                        "protected": False,
                        "fortuneTellerRedHerring": False,
                        "impBluffs": [],
                        "note": "",
                    }
                )
            self.state["phase"] = "lobby"
            self.state["day"] = 0
            self.state["night"] = 0
            self.state["activeVote"] = None
            self.state["voteHistory"] = []
            self.state["execution"] = {"candidateId": None, "topVotes": 0, "tied": False}
            self.state["abilityRequests"] = []
            self.state["nightProgress"] = None
            self.state["impBluffsAssigned"] = False
            self.state["messages"] = {p["id"]: [] for p in self.state["players"]}
            self._touch("플레이어를 유지하고 게임을 초기화했습니다.")
        self.broadcast()

    def _touch(self, message=None):
        self.state["updatedAt"] = now_ms()
        if message:
            self._log(message)

    def _log(self, message):
        self.state["log"].insert(
            0,
            {
                "id": str(uuid.uuid4()),
                "time": now_ms(),
                "message": message,
            },
        )
        self.state["log"] = self.state["log"][:80]

    def add_client(self, client):
        with self.lock:
            self.clients.append(client)

    def remove_client(self, client):
        with self.lock:
            if client in self.clients:
                self.clients.remove(client)

    def broadcast(self):
        with self.lock:
            clients = list(self.clients)
        for client in clients:
            try:
                while client["queue"].qsize() > 1:
                    client["queue"].get_nowait()
                client["queue"].put_nowait(self.snapshot(client["mode"], client["auth"]))
            except queue.Full:
                pass

    def snapshot(self, mode, auth):
        with self.lock:
            if mode == "host" and auth.get("pin") == HOST_PIN:
                return self.host_state()
            if mode == "player":
                return self.player_state(auth.get("playerId"), auth.get("secret"))
            return self.public_state()

    def public_state(self):
        return {
            "mode": "public",
            "serverNow": now_ms(),
            "phase": self.state["phase"],
            "scriptName": self.state["scriptName"],
            "players": [
                {
                    "id": p["id"],
                    "name": p["name"],
                    "seat": p["seat"],
                    "alive": p["alive"],
                }
                for p in self.state["players"]
            ],
            "urls": get_lan_urls(),
            "roles": [role_public(role["id"]) for role in ROLE_CATALOG],
            "minPlayers": MIN_PLAYERS,
            "maxPlayers": MAX_PLAYERS,
        }

    def host_state(self):
        players = []
        for player in self.state["players"]:
            players.append(
                {
                    **{key: value for key, value in player.items() if key != "secret"},
                    "role": role_public(player.get("roleId")),
                    "shownRole": role_public(player.get("shownRoleId")),
                    "impBluffRoles": [role_public(role_id) for role_id in player.get("impBluffs", [])],
                }
            )
        return {
            "mode": "host",
            "valid": True,
            "serverNow": now_ms(),
            "phase": self.state["phase"],
            "scriptName": self.state["scriptName"],
            "day": self.state["day"],
            "night": self.state["night"],
            "players": players,
            "activeVote": self._vote_for_view(),
            "voteHistory": self._vote_history_for_view(),
            "execution": self._execution_for_view(),
            "abilityRequests": self._requests_for_view(),
            "nightProgress": self._night_progress_for_view(),
            "messages": self._messages_for_host(),
            "log": self.state["log"][:30],
            "roles": [role_public(role["id"]) for role in ROLE_CATALOG],
            "nightTasks": self.night_tasks(),
            "urls": get_lan_urls(),
            "setupCounts": SETUP_COUNTS,
            "minPlayers": MIN_PLAYERS,
            "maxPlayers": MAX_PLAYERS,
        }

    def player_state(self, player_id, secret):
        player = self._find_player(player_id)
        if not player or player.get("secret") != secret:
            return {"mode": "player", "valid": False, "error": "player_not_found"}

        return {
            "mode": "player",
            "valid": True,
            "serverNow": now_ms(),
            "phase": self.state["phase"],
            "scriptName": self.state["scriptName"],
            "day": self.state["day"],
            "night": self.state["night"],
            "me": {
                "id": player["id"],
                "name": player["name"],
                "seat": player["seat"],
                "alive": player["alive"],
                "voteToken": player["voteToken"],
                "role": role_public(player.get("shownRoleId")),
                "impBluffs": [
                    role_public(role_id)
                    for role_id in player.get("impBluffs", [])
                    if player.get("roleId") == "imp"
                ],
            },
            "players": [
                {
                    "id": p["id"],
                    "name": p["name"],
                    "seat": p["seat"],
                    "alive": p["alive"],
                    "voteToken": p["voteToken"],
                }
                for p in self.state["players"]
            ],
            "activeVote": self._vote_for_view(),
            "nightTurn": self._night_turn_for_player(player["id"]),
            "abilityRequests": [
                self._request_for_player_view(req)
                for req in self.state["abilityRequests"]
                if req["playerId"] == player["id"] and req.get("status") == "pending"
            ][:12],
            "messages": self.state["messages"].get(player["id"], [])[:30],
            "urls": get_lan_urls(),
            "minPlayers": MIN_PLAYERS,
            "maxPlayers": MAX_PLAYERS,
        }

    def _messages_for_host(self):
        output = {}
        for player in self.state["players"]:
            output[player["id"]] = self.state["messages"].get(player["id"], [])[:10]
        return output

    def _find_player(self, player_id):
        for player in self.state["players"]:
            if player["id"] == player_id:
                return player
        return None

    def _find_player_name(self, player_id):
        player = self._find_player(player_id)
        return player["name"] if player else "알 수 없음"

    def _find_player_seat(self, player_id):
        player = self._find_player(player_id)
        return player["seat"] if player else None

    def _vote_eligible(self, player):
        return bool(player["alive"] or player["voteToken"])

    def _clockwise_players_after(self, nominee):
        players = sorted(self.state["players"], key=lambda item: item["seat"])
        nominee_index = next(
            (index for index, player in enumerate(players) if player["id"] == nominee["id"]),
            -1,
        )
        if nominee_index < 0:
            return players
        return players[nominee_index:] + players[:nominee_index]

    def _vote_for_view(self):
        active = self.state["activeVote"]
        if not active:
            return None
        votes = []
        order = []
        yes_count = 0
        for player_id, yes in active["votes"].items():
            if yes:
                yes_count += 1
            votes.append(
                {
                    "playerId": player_id,
                    "playerName": self._find_player_name(player_id),
                    "yes": bool(yes),
                }
            )
        timed_out = set(active.get("timedOutIds", []))
        current_id = self._current_vote_player_id(active)
        for index, player_id in enumerate(active.get("order", [])):
            player = self._find_player(player_id)
            vote_value = active["votes"].get(player_id)
            choice_value = active.get("choices", {}).get(player_id)
            if vote_value is True:
                status = "yes"
            elif vote_value is False and player_id in timed_out:
                status = "timeout"
            elif vote_value is False:
                status = "no"
            elif choice_value is True:
                status = "choice_yes"
            elif choice_value is False:
                status = "choice_no"
            elif player_id == current_id:
                status = "current"
            else:
                status = "waiting" if index > active.get("currentIndex", 0) else "skipped"
            order.append(
                {
                    "playerId": player_id,
                    "playerName": player["name"] if player else self._find_player_name(player_id),
                    "seat": player["seat"] if player else None,
                    "yes": vote_value,
                    "choice": choice_value,
                    "status": status,
                }
            )
        return {
            **active,
            "nomineeName": self._find_player_name(active["nomineeId"]),
            "nomineeSeat": self._find_player_seat(active["nomineeId"]),
            "currentVoterId": current_id,
            "currentVoterName": self._find_player_name(current_id) if current_id else None,
            "currentVoterSeat": self._find_player_seat(current_id) if current_id else None,
            "yesCount": yes_count,
            "votes": votes,
            "order": order,
        }

    def _vote_history_for_view(self):
        output = []
        for vote in self.state["voteHistory"][:10]:
            output.append(
                {
                    **vote,
                    "nomineeName": self._find_player_name(vote["nomineeId"]),
                }
            )
        return output

    def _execution_for_view(self):
        execution = self.state["execution"]
        candidate_id = execution.get("candidateId")
        return {
            **execution,
            "candidateName": self._find_player_name(candidate_id) if candidate_id else None,
        }

    def _request_for_view(self, request):
        return {
            **request,
            "playerName": self._find_player_name(request["playerId"]),
            "role": role_public(request.get("roleId")),
            "actualRole": role_public(request.get("actualRoleId")),
            "targetNames": [self._find_player_name(pid) for pid in request.get("targetIds", [])],
            "impTransferOptions": [
                {
                    "id": player["id"],
                    "name": player["name"],
                    "seat": player["seat"],
                    "role": role_public(player.get("roleId")),
                }
                for player in self._living_minions_except(request.get("playerId"))
            ]
            if request.get("impTransferPending")
            else [],
        }

    def _requests_for_view(self):
        return [self._request_for_view(req) for req in self.state["abilityRequests"][:40] if not req.get("dismissed")]

    def _request_for_player_view(self, request):
        return {
            "id": request["id"],
            "role": role_public(request.get("roleId")),
            "targetNames": [self._find_player_name(pid) for pid in request.get("targetIds", [])],
            "note": request.get("note", ""),
            "status": request.get("status", "pending"),
            "createdAt": request.get("createdAt"),
        }

    def _night_tasks_raw(self):
        is_first = self.state["night"] <= 1
        tasks = []
        for player in self.state["players"]:
            shown_role_id = player.get("shownRoleId") or player.get("roleId")
            role = ROLE_BY_ID.get(shown_role_id)
            if not role:
                continue
            include = role["firstNight"] if is_first else role["otherNight"]
            if role["id"] == "ravenkeeper" and not player["alive"] and not is_first:
                include = True
            if not include:
                continue
            if not player["alive"] and role["id"] != "ravenkeeper":
                continue
            order = role["firstOrder"] if is_first else role["otherOrder"]
            tasks.append(
                {
                    "playerId": player["id"],
                    "playerName": player["name"],
                    "role": role_public(role["id"]),
                    "actualRole": role_public(player.get("roleId")),
                    "order": order or 99,
                }
            )
        return sorted(tasks, key=lambda item: (item["order"], item["playerName"]))

    def night_tasks(self):
        tasks = self._night_tasks_raw()
        progress = self.state.get("nightProgress") or {}
        active = self.state["phase"] == "night" and progress.get("night") == self.state["night"]
        index = min(max(int(progress.get("index", 0)), 0), len(tasks)) if active else None
        output = []
        for task_index, task in enumerate(tasks):
            if not active:
                status = "waiting"
            elif task_index < index:
                status = "done"
            elif task_index == index:
                status = "current"
            else:
                status = "waiting"
            output.append({**task, "position": task_index + 1, "status": status})
        return output

    def _night_progress_for_view(self):
        if self.state["phase"] != "night":
            return {"active": False, "complete": False}
        tasks = self._night_tasks_raw()
        progress = self.state.get("nightProgress")
        if not progress or progress.get("night") != self.state["night"]:
            progress = self._reset_night_progress_locked()
        index = min(max(int(progress.get("index", 0)), 0), len(tasks))
        progress["index"] = index
        current_task = tasks[index] if index < len(tasks) else None
        return {
            "active": True,
            "night": self.state["night"],
            "isFirstNight": self.state["night"] <= 1,
            "currentIndex": index,
            "total": len(tasks),
            "complete": current_task is None,
            "currentTask": current_task,
        }

    def _night_turn_for_player(self, player_id):
        progress = self._night_progress_for_view()
        if not progress["active"]:
            return {"active": False, "complete": False}
        current_task = progress.get("currentTask")
        is_mine = bool(current_task and current_task["playerId"] == player_id)
        output = {
            "active": True,
            "night": progress["night"],
            "isFirstNight": progress["isFirstNight"],
            "currentIndex": progress["currentIndex"],
            "total": progress["total"],
            "complete": progress["complete"],
            "isMine": is_mine,
        }
        if is_mine:
            output["currentTask"] = current_task
        return output

    def _reset_night_progress_locked(self):
        self.state["nightProgress"] = {
            "night": self.state["night"],
            "index": 0,
            "startedAt": now_ms(),
        }
        return self.state["nightProgress"]

    def join(self, name):
        name = clean_name(name)
        if not name:
            raise ValueError("이름을 입력해 주세요.")
        with self.lock:
            if len(self.state["players"]) >= MAX_PLAYERS:
                raise ValueError(f"현재 버전은 최대 {MAX_PLAYERS}명까지 접속할 수 있어요.")
            if any(p["name"].lower() == name.lower() for p in self.state["players"]):
                raise ValueError("이미 사용 중인 이름이에요.")
            player = {
                "id": str(uuid.uuid4()),
                "secret": secrets.token_urlsafe(18),
                "name": name,
                "seat": len(self.state["players"]) + 1,
                "alive": True,
                "voteToken": True,
                "roleId": None,
                "shownRoleId": None,
                "poisoned": False,
                "drunk": False,
                "protected": False,
                "fortuneTellerRedHerring": False,
                "impBluffs": [],
                "note": "",
            }
            self.state["players"].append(player)
            self.state["messages"][player["id"]] = []
            self._touch(f"{name} 님이 참가했습니다.")
            result = {"playerId": player["id"], "secret": player["secret"], "name": name}
        self.broadcast()
        return result

    def assign_roles(self):
        with self.lock:
            count = len(self.state["players"])
            if count not in SETUP_COUNTS:
                raise ValueError(
                    f"Trouble Brewing 자동 배정은 {MIN_PLAYERS}명부터 {MAX_PLAYERS}명까지 지원해요."
                )
            counts = dict(SETUP_COUNTS[count])
            roles_by_type = {
                role_type: [role for role in ROLE_CATALOG if role["type"] == role_type]
                for role_type in ROLE_TYPES
            }

            selected_minions = random.sample(roles_by_type["minion"], counts["minion"])
            if any(role["id"] == "baron" for role in selected_minions):
                extra = min(2, counts["townsfolk"])
                counts["townsfolk"] -= extra
                counts["outsider"] += extra

            selected = []
            selected.extend(random.sample(roles_by_type["townsfolk"], counts["townsfolk"]))
            selected.extend(random.sample(roles_by_type["outsider"], counts["outsider"]))
            selected.extend(selected_minions)
            selected.extend(random.sample(roles_by_type["demon"], counts["demon"]))
            random.shuffle(selected)

            actual_townsfolk_ids = {role["id"] for role in selected if role["type"] == "townsfolk"}
            drunk_show_options = [
                role for role in roles_by_type["townsfolk"] if role["id"] not in actual_townsfolk_ids
            ] or roles_by_type["townsfolk"]

            for player, role in zip(self.state["players"], selected):
                shown_role_id = role["id"]
                if role["id"] == "drunk":
                    shown_role_id = random.choice(drunk_show_options)["id"]
                player.update(
                    {
                        "alive": True,
                        "voteToken": True,
                        "roleId": role["id"],
                        "shownRoleId": shown_role_id,
                        "poisoned": False,
                        "drunk": role["id"] == "drunk",
                        "protected": False,
                        "fortuneTellerRedHerring": False,
                        "impBluffs": [],
                    }
                )

            self._assign_fortune_teller_red_herring_locked()
            self.state["impBluffsAssigned"] = False
            self.state["phase"] = "lobby"
            self.state["activeVote"] = None
            self.state["voteHistory"] = []
            self.state["execution"] = {"candidateId": None, "topVotes": 0, "tied": False}
            self.state["nightProgress"] = None
            self._touch("역할을 배정했습니다.")
        self.broadcast()

    def _assign_fortune_teller_red_herring_locked(self):
        for player in self.state["players"]:
            player["fortuneTellerRedHerring"] = False

        has_fortune_teller = any(player.get("roleId") == "fortune_teller" for player in self.state["players"])
        if not has_fortune_teller:
            return

        good_players = [
            player
            for player in self.state["players"]
            if (ROLE_BY_ID.get(player.get("roleId")) or {}).get("team") == "선"
        ]
        candidates = [player for player in good_players if player.get("roleId") != "fortune_teller"] or good_players
        if candidates:
            random.choice(candidates)["fortuneTellerRedHerring"] = True

    def _assign_imp_bluffs_locked(self):
        actual_role_ids = {player.get("roleId") for player in self.state["players"] if player.get("roleId")}
        bluff_options = [
            role
            for role in ROLE_CATALOG
            if role["type"] == "townsfolk" and role["id"] not in actual_role_ids
        ]
        bluffs = [role["id"] for role in random.sample(bluff_options, min(3, len(bluff_options)))]
        for player in self.state["players"]:
            player["impBluffs"] = bluffs[:] if player.get("roleId") == "imp" else []

    def start_night(self):
        with self.lock:
            if self.state["phase"] not in {"lobby", "day"}:
                raise ValueError("낮에서 밤으로만 넘어갈 수 있어요.")
            if not self.state["players"] or any(not player.get("roleId") for player in self.state["players"]):
                raise ValueError("역할을 배정한 뒤 밤을 시작해 주세요.")
            self.state["night"] += 1
            if self.state["night"] == 1 and not self.state.get("impBluffsAssigned"):
                self._assign_imp_bluffs_locked()
                self.state["impBluffsAssigned"] = True
            self.state["phase"] = "night"
            self.state["activeVote"] = None
            self.state["execution"] = {"candidateId": None, "topVotes": 0, "tied": False}
            for player in self.state["players"]:
                player["protected"] = False
            self._reset_night_progress_locked()
            self._touch(f"{self.state['night']}번째 밤을 시작했습니다.")
        self.broadcast()

    def start_day(self):
        with self.lock:
            if self.state["phase"] != "night":
                raise ValueError("밤에서 낮으로만 넘어갈 수 있어요.")
            self.state["day"] += 1
            self.state["phase"] = "day"
            self.state["activeVote"] = None
            self.state["execution"] = {"candidateId": None, "topVotes": 0, "tied": False}
            self.state["voteHistory"] = []
            self.state["nightProgress"] = None
            self._touch(f"{self.state['day']}번째 낮을 시작했습니다.")
        self.broadcast()

    def step_night(self, direction):
        with self.lock:
            if self.state["phase"] != "night":
                raise ValueError("밤이 진행 중일 때만 차례를 넘길 수 있어요.")
            tasks = self._night_tasks_raw()
            progress = self.state.get("nightProgress")
            if not progress or progress.get("night") != self.state["night"]:
                progress = self._reset_night_progress_locked()
            index = min(max(int(progress.get("index", 0)), 0), len(tasks))
            if direction == "previous":
                index = max(0, index - 1)
            elif direction == "restart":
                index = 0
            else:
                index = min(len(tasks), index + 1)
            progress["index"] = index
            current = tasks[index] if index < len(tasks) else None
            if current:
                message = f"밤 차례: {current['playerName']} 님의 {current['role']['name']} 능력."
            else:
                message = "밤 차례를 모두 진행했습니다."
            self._touch(message)
        self.broadcast()

    def toggle_player_field(self, player_id, field):
        allowed = {"alive", "voteToken", "poisoned", "drunk", "protected", "fortuneTellerRedHerring"}
        if field not in allowed:
            raise ValueError("바꿀 수 없는 상태예요.")
        with self.lock:
            player = self._find_player(player_id)
            if not player:
                raise ValueError("플레이어를 찾을 수 없어요.")
            if field == "fortuneTellerRedHerring":
                if player.get(field):
                    player[field] = False
                else:
                    role = ROLE_BY_ID.get(player.get("roleId"))
                    if not role or role.get("team") != "선":
                        raise ValueError("선팀 플레이어만 점쟁이 미끼로 지정할 수 있어요.")
                    for item in self.state["players"]:
                        item["fortuneTellerRedHerring"] = False
                    player[field] = True
                self._touch()
                self.broadcast()
                return
            player[field] = not bool(player[field])
            self._touch(f"{player['name']} 상태를 변경했습니다.")
        self.broadcast()

    def remove_player(self, player_id):
        with self.lock:
            player = self._find_player(player_id)
            if not player:
                raise ValueError("플레이어를 찾을 수 없어요.")
            self.state["players"] = [item for item in self.state["players"] if item["id"] != player_id]
            for index, item in enumerate(self.state["players"], start=1):
                item["seat"] = index
            self.state["messages"].pop(player_id, None)
            self.state["abilityRequests"] = [
                request for request in self.state["abilityRequests"] if request.get("playerId") != player_id
            ]
            active_vote = self.state.get("activeVote")
            if active_vote and (
                active_vote.get("nomineeId") == player_id
                or any(vote.get("playerId") == player_id for vote in active_vote.get("order", []))
            ):
                self.state["activeVote"] = None
            if self.state.get("nightProgress"):
                self.state["nightProgress"] = None
            self._touch(f"{player['name']} 님을 플레이어 목록에서 제거했습니다.")
        self.broadcast()

    def leave_player(self, player_id, secret):
        with self.lock:
            player = self._find_player(player_id)
            if not player or player.get("secret") != secret:
                raise ValueError("플레이어 정보를 확인할 수 없어요.")
        self.remove_player(player_id)

    def update_note(self, player_id, note):
        with self.lock:
            player = self._find_player(player_id)
            if not player:
                raise ValueError("플레이어를 찾을 수 없어요.")
            player["note"] = str(note or "")[:300]
            self._touch()
        self.broadcast()

    def send_message(self, player_id, message):
        message = str(message or "").strip()[:500]
        if not message:
            raise ValueError("보낼 내용을 입력해 주세요.")
        with self.lock:
            player = self._find_player(player_id)
            if not player:
                raise ValueError("플레이어를 찾을 수 없어요.")
            self.state["messages"].setdefault(player_id, []).insert(
                0,
                {
                    "id": str(uuid.uuid4()),
                    "time": now_ms(),
                    "text": message,
                },
            )
            self.state["messages"][player_id] = self.state["messages"][player_id][:50]
            self._touch(f"{player['name']} 님에게 비밀 메시지를 보냈습니다.")
        self.broadcast()

    def player_message(self, player_id, secret, message):
        message = str(message or "").strip()[:500]
        if not message:
            raise ValueError("보낼 내용을 입력해 주세요.")
        with self.lock:
            player = self._find_player(player_id)
            if not player or player.get("secret") != secret:
                raise ValueError("플레이어 정보를 확인할 수 없어요.")
            self.state["messages"].setdefault(player_id, []).insert(
                0,
                {
                    "id": str(uuid.uuid4()),
                    "time": now_ms(),
                    "text": message,
                    "from": "player",
                },
            )
            self.state["messages"][player_id] = self.state["messages"][player_id][:50]
            self._touch()
        self.broadcast()

    def _current_vote_player_id(self, active):
        order = active.get("order") or []
        index = active.get("currentIndex", 0)
        if active.get("open") and 0 <= index < len(order):
            return order[index]
        return None

    def _vote_due_count(self, active, current_time):
        order_count = len(active.get("order", []))
        if order_count == 0 or current_time < active.get("voteStartedAt", 0):
            return 0
        vote_duration = active.get("voteDurationMs", VOTE_DURATION_MS)
        elapsed = current_time - active.get("voteStartedAt", current_time)
        if elapsed >= vote_duration:
            return order_count
        if order_count == 1:
            return 1
        return min(order_count, int(elapsed * (order_count - 1) / vote_duration) + 1)

    def _commit_vote_choice_locked(self, active, player_id):
        if player_id in active["votes"]:
            return
        choice = active.get("choices", {}).get(player_id)
        if choice is None:
            active["votes"][player_id] = False
            if player_id not in active["timedOutIds"]:
                active["timedOutIds"].append(player_id)
            return
        active["votes"][player_id] = bool(choice)

    def _apply_due_votes_locked(self, active, current_time):
        changed = False
        due_count = self._vote_due_count(active, current_time)
        order = active.get("order", [])
        while active.get("currentIndex", 0) < due_count:
            player_id = order[active["currentIndex"]]
            self._commit_vote_choice_locked(active, player_id)
            active["currentIndex"] += 1
            changed = True
        if active.get("currentIndex", 0) >= len(order) and order:
            self._finish_active_vote_locked("투표가 종료되었습니다.")
            return True
        return changed

    def _finish_active_vote_locked(self, message):
        active = self.state["activeVote"]
        if not active:
            return
        for player_id in active.get("order", []):
            self._commit_vote_choice_locked(active, player_id)
        yes_voters = [pid for pid, yes in active["votes"].items() if yes]
        yes_count = len(yes_voters)
        used_ghost_voters = []
        for player_id in active.get("choices", {}):
            player = self._find_player(player_id)
            if player and not player["alive"]:
                player["voteToken"] = False
                used_ghost_voters.append(player_id)

        record = {
            "id": active["id"],
            "nomineeId": active["nomineeId"],
            "votes": yes_count,
            "required": active["required"],
            "passed": yes_count >= active["required"],
            "voterIds": yes_voters,
            "ghostVoterIds": used_ghost_voters,
            "order": active.get("order", []),
            "timedOutIds": active.get("timedOutIds", []),
        }
        self.state["voteHistory"].insert(0, record)
        execution = self.state["execution"]
        if record["passed"]:
            if yes_count > execution["topVotes"]:
                execution.update(
                    {"candidateId": active["nomineeId"], "topVotes": yes_count, "tied": False}
                )
            elif yes_count == execution["topVotes"]:
                execution.update({"candidateId": None, "topVotes": yes_count, "tied": True})
        self.state["activeVote"] = None
        self._touch(message)

    def _start_vote_timer(self, vote_id):
        thread = threading.Thread(target=self._vote_timer_loop, args=(vote_id,), daemon=True)
        thread.start()

    def _vote_timer_loop(self, vote_id):
        while True:
            sleep_seconds = None
            should_broadcast = False
            with self.lock:
                active = self.state["activeVote"]
                if not active or active["id"] != vote_id or not active.get("open"):
                    return
                current_time = now_ms()
                if self._apply_due_votes_locked(active, current_time):
                    should_broadcast = True
                else:
                    active = self.state["activeVote"]
                    if not active or active["id"] != vote_id:
                        should_broadcast = True
                    else:
                        order_count = len(active.get("order", []))
                        if current_time < active.get("voteStartedAt", 0):
                            next_at = active.get("voteStartedAt", current_time)
                        else:
                            index = active.get("currentIndex", 0)
                            if index >= order_count:
                                next_at = current_time
                            else:
                                interval = active.get("voteDurationMs", VOTE_DURATION_MS) / max(
                                    1, order_count - 1
                                )
                                next_at = active.get("voteStartedAt", current_time) + int(index * interval)
                        sleep_seconds = max(0.03, min((next_at - current_time) / 1000, 0.25))
            if should_broadcast:
                self.broadcast()
            if sleep_seconds is not None:
                time.sleep(sleep_seconds)

    def start_vote(self, nominee_id):
        with self.lock:
            if self.state["phase"] != "day":
                raise ValueError("투표는 낮에만 시작할 수 있어요.")
            if self.state["activeVote"]:
                raise ValueError("이미 진행 중인 투표가 있어요.")
            nominee = self._find_player(nominee_id)
            if not nominee:
                raise ValueError("지명 대상을 찾을 수 없어요.")
            if not nominee["alive"]:
                raise ValueError("사망한 플레이어는 지명할 수 없어요.")
            if any(vote.get("nomineeId") == nominee_id for vote in self.state["voteHistory"]):
                raise ValueError("이 플레이어는 오늘 이미 투표 후보가 되었어요.")
            alive_count = sum(1 for player in self.state["players"] if player["alive"])
            required = (alive_count + 1) // 2
            order = [
                player["id"]
                for player in self._clockwise_players_after(nominee)
                if self._vote_eligible(player)
            ]
            if not order:
                raise ValueError("투표 가능한 플레이어가 없습니다.")
            vote_id = str(uuid.uuid4())
            now = now_ms()
            self.state["activeVote"] = {
                "id": vote_id,
                "nomineeId": nominee_id,
                "required": required,
                "aliveCount": alive_count,
                "votes": {},
                "choices": {},
                "order": order,
                "currentIndex": 0,
                "prepDurationMs": VOTE_PREP_MS,
                "voteDurationMs": VOTE_DURATION_MS,
                "startedAt": now,
                "prepEndsAt": now + VOTE_PREP_MS,
                "voteStartedAt": now + VOTE_PREP_MS,
                "deadlineAt": now + VOTE_PREP_MS + VOTE_DURATION_MS,
                "timedOutIds": [],
                "open": True,
            }
            self._touch(f"{nominee['name']} 님에 대한 투표를 시작했습니다.")
        self.broadcast()
        self._start_vote_timer(vote_id)

    def cast_vote(self, player_id, secret, yes):
        with self.lock:
            player = self._find_player(player_id)
            active = self.state["activeVote"]
            if not player or player.get("secret") != secret:
                raise ValueError("플레이어 정보를 확인할 수 없어요.")
            if not active or not active.get("open"):
                raise ValueError("진행 중인 투표가 없어요.")
            eligible = player["alive"] or player["voteToken"]
            if not eligible:
                raise ValueError("투표권이 남아 있지 않아요.")
            if player_id not in active.get("order", []):
                raise ValueError("이번 투표 순서에 없는 플레이어예요.")
            if player_id in active["votes"]:
                raise ValueError("이미 차례가 지나가 투표가 확정되었습니다.")
            active.setdefault("choices", {})[player_id] = bool(yes)
            self._touch(f"{player['name']} 님의 투표 선택을 저장했습니다.")
        self.broadcast()

    def close_vote(self):
        with self.lock:
            active = self.state["activeVote"]
            if not active:
                raise ValueError("진행 중인 투표가 없어요.")
            self._finish_active_vote_locked("투표를 마감했습니다.")
        self.broadcast()

    def execute_candidate(self):
        with self.lock:
            candidate_id = self.state["execution"].get("candidateId")
            player = self._find_player(candidate_id)
            if not player:
                raise ValueError("처형할 플레이어가 정해지지 않았어요.")
            player["alive"] = False
            self.state["execution"] = {"candidateId": None, "topVotes": 0, "tied": False}
            self.state["activeVote"] = None
            self._touch(f"{player['name']} 님을 처형 처리했습니다.")
        self.broadcast()

    def _living_minions_except(self, player_id):
        minions = []
        for player in self.state["players"]:
            role = ROLE_BY_ID.get(player.get("roleId"))
            if player["id"] != player_id and player["alive"] and role and role["type"] == "minion":
                minions.append(player)
        return sorted(minions, key=lambda item: item["seat"])

    def _add_private_message_locked(self, player_id, text):
        self.state["messages"].setdefault(player_id, []).insert(
            0,
            {
                "id": str(uuid.uuid4()),
                "time": now_ms(),
                "text": text,
            },
        )

    def _advance_current_night_turn_locked(self, player_id):
        progress = self.state.get("nightProgress")
        if self.state["phase"] != "night" or not progress:
            return
        current = self._night_progress_for_view().get("currentTask")
        if current and current.get("playerId") == player_id:
            tasks = self._night_tasks_raw()
            progress["index"] = min(int(progress.get("index", 0)) + 1, len(tasks))

    def _apply_imp_self_kill_locked(self, player, request):
        target_ids = request.get("targetIds", [])
        if player.get("roleId") != "imp" or player["id"] not in target_ids:
            return None
        if not player["alive"]:
            return "임프 자결 요청을 받았지만 이미 사망한 상태입니다."

        player["alive"] = False
        request["impTransferPending"] = True
        request["impTransferOptions"] = [p["id"] for p in self._living_minions_except(player["id"])]
        self._add_private_message_locked(player["id"], "임프 자결이 처리되어 사망했습니다.")
        if not request["impTransferOptions"]:
            request["impTransferPending"] = False
            self._advance_current_night_turn_locked(player["id"])
            return (
                f"임프 자결 처리: {player['name']} 님이 사망했습니다. "
                "살아있는 하수인이 없어 임프가 넘어가지 않았습니다."
            )
        return (
            f"임프 자결 처리: {player['name']} 님이 사망했습니다. "
            "스토리텔러가 새 임프가 될 하수인을 선택해야 합니다."
        )

    def transfer_imp(self, request_id, successor_id):
        with self.lock:
            request = next(
                (item for item in self.state["abilityRequests"] if item["id"] == request_id),
                None,
            )
            if not request or not request.get("impTransferPending"):
                raise ValueError("새 임프를 정할 수 있는 요청이 아니에요.")
            old_imp = self._find_player(request.get("playerId"))
            successor = self._find_player(successor_id)
            if not old_imp or not successor:
                raise ValueError("플레이어를 찾을 수 없어요.")
            role = ROLE_BY_ID.get(successor.get("roleId"))
            if not successor["alive"] or not role or role["type"] != "minion":
                raise ValueError("살아있는 하수인만 새 임프가 될 수 있어요.")

            old_role_name = role_public(successor.get("roleId"))["name"]
            successor["roleId"] = "imp"
            successor["shownRoleId"] = "imp"
            successor["drunk"] = False
            successor["impBluffs"] = []
            request["status"] = "resolved"
            request["impTransferPending"] = False
            request["impTransferToId"] = successor["id"]
            request["result"] = (
                f"임프 자결 처리: {old_imp['name']} 님이 사망했고 "
                f"{successor['name']} 님이 {old_role_name}에서 새 임프가 되었습니다."
            )
            self._add_private_message_locked(successor["id"], "당신은 새 임프가 되었습니다.")
            self._advance_current_night_turn_locked(old_imp["id"])
            self._touch()
        self.broadcast()

    def ability_request(self, player_id, secret, target_ids, note):
        note = str(note or "").strip()[:500]
        target_ids = [pid for pid in target_ids if self._find_player(pid)]
        with self.lock:
            player = self._find_player(player_id)
            if not player or player.get("secret") != secret:
                raise ValueError("플레이어 정보를 확인할 수 없어요.")
            role_id = player.get("shownRoleId")
            if not role_id:
                raise ValueError("아직 역할이 배정되지 않았어요.")
            if self.state["phase"] != "night":
                raise ValueError("능력 요청은 밤에만 보낼 수 있어요. 낮에는 메시지를 사용해 주세요.")
            if any(
                request.get("playerId") == player_id and request.get("status") == "pending"
                for request in self.state["abilityRequests"]
            ):
                raise ValueError("스토리텔러가 이전 요청을 처리할 때까지 새 요청을 보낼 수 없어요.")
            if self.state["phase"] == "night":
                progress = self._night_progress_for_view()
                current_task = progress.get("currentTask")
                if not current_task or current_task["playerId"] != player_id:
                    raise ValueError("아직 당신의 밤 차례가 아니에요.")
                if progress.get("isFirstNight") and player.get("roleId") == "imp":
                    raise ValueError("첫날밤 임프는 공격하지 않고 블러프만 확인해요.")
            request = {
                "id": str(uuid.uuid4()),
                "playerId": player_id,
                "roleId": role_id,
                "actualRoleId": player.get("roleId"),
                "targetIds": target_ids[:3],
                "note": note,
                "status": "pending",
                "result": "",
                "createdAt": now_ms(),
            }
            imp_result = self._apply_imp_self_kill_locked(player, request)
            if imp_result:
                request["result"] = imp_result
                if not request.get("impTransferPending"):
                    request["status"] = "resolved"
            self.state["abilityRequests"].insert(0, request)
            self.state["abilityRequests"] = self.state["abilityRequests"][:80]
            self._touch()
        self.broadcast()

    def resolve_request(self, request_id, result, send_to_player, ignored=False):
        result = str(result or "").strip()[:500]
        with self.lock:
            request = next(
                (item for item in self.state["abilityRequests"] if item["id"] == request_id),
                None,
            )
            if not request:
                raise ValueError("요청을 찾을 수 없어요.")
            request["status"] = "ignored" if ignored else "resolved"
            request["result"] = result
            if send_to_player and result:
                self.state["messages"].setdefault(request["playerId"], []).insert(
                    0,
                    {
                        "id": str(uuid.uuid4()),
                        "time": now_ms(),
                        "text": result,
                    },
                )
            self._touch()
        self.broadcast()

    def dismiss_request(self, request_id):
        with self.lock:
            request = next(
                (item for item in self.state["abilityRequests"] if item["id"] == request_id),
                None,
            )
            if not request:
                raise ValueError("요청을 찾을 수 없어요.")
            request["dismissed"] = True
            self._touch()
        self.broadcast()


STORE = GameStore()


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "BOTCHelper/0.1"

    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/events":
            self.handle_events(parsed)
            return
        if parsed.path == "/api/state":
            query = parse_qs(parsed.query)
            mode = query.get("mode", ["public"])[0]
            auth = {
                "pin": query.get("pin", [""])[0],
                "playerId": query.get("playerId", [""])[0],
                "secret": query.get("secret", [""])[0],
            }
            self.write_json(STORE.snapshot(mode, auth))
            return
        if parsed.path == "/api/config":
            self.write_json({"urls": get_lan_urls(), "scriptName": "Trouble Brewing"})
            return
        self.serve_static(parsed.path)

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            data = self.read_json()
            result = self.route_post(parsed.path, data)
            self.write_json({"ok": True, "result": result})
        except ValueError as exc:
            self.write_json({"ok": False, "error": str(exc)}, status=400)
        except Exception as exc:
            self.write_json({"ok": False, "error": f"처리 중 오류가 났어요: {exc}"}, status=500)

    def route_post(self, path, data):
        if path == "/api/join":
            return STORE.join(data.get("name"))
        if path == "/api/vote":
            STORE.cast_vote(
                data.get("playerId"),
                data.get("secret"),
                bool(data.get("yes")),
            )
            return {}
        if path == "/api/ability":
            STORE.ability_request(
                data.get("playerId"),
                data.get("secret"),
                data.get("targetIds") or [],
                data.get("note") or "",
            )
            return {}
        if path == "/api/message":
            STORE.player_message(
                data.get("playerId"),
                data.get("secret"),
                data.get("message") or "",
            )
            return {}
        if path == "/api/leave":
            STORE.leave_player(data.get("playerId"), data.get("secret"))
            return {}

        if not self.host_allowed(data):
            raise ValueError("스토리텔러 PIN이 맞지 않아요.")

        if path == "/api/host/login":
            return {"host": True}
        if path == "/api/host/assign":
            STORE.assign_roles()
        elif path == "/api/host/transfer-imp":
            STORE.transfer_imp(data.get("requestId"), data.get("playerId"))
        elif path == "/api/host/reset-all":
            STORE.reset_everything()
        elif path == "/api/host/reset-game":
            STORE.reset_game_keep_players()
        elif path == "/api/host/start-night":
            STORE.start_night()
        elif path == "/api/host/night-step":
            STORE.step_night(data.get("direction") or "next")
        elif path == "/api/host/start-day":
            STORE.start_day()
        elif path == "/api/host/toggle-player":
            STORE.toggle_player_field(data.get("playerId"), data.get("field"))
        elif path == "/api/host/remove-player":
            STORE.remove_player(data.get("playerId"))
        elif path == "/api/host/note":
            STORE.update_note(data.get("playerId"), data.get("note") or "")
        elif path == "/api/host/message":
            STORE.send_message(data.get("playerId"), data.get("message") or "")
        elif path == "/api/host/start-vote":
            STORE.start_vote(data.get("nomineeId"))
        elif path == "/api/host/close-vote":
            STORE.close_vote()
        elif path == "/api/host/execute":
            STORE.execute_candidate()
        elif path == "/api/host/resolve-request":
            STORE.resolve_request(
                data.get("requestId"),
                data.get("result") or "",
                bool(data.get("sendToPlayer")),
                bool(data.get("ignored")),
            )
        elif path == "/api/host/dismiss-request":
            STORE.dismiss_request(data.get("requestId"))
        else:
            raise ValueError("알 수 없는 요청이에요.")
        return {}

    def host_allowed(self, data):
        return str(data.get("pin") or "") == HOST_PIN

    def read_json(self):
        length = int(self.headers.get("Content-Length") or "0")
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw or "{}")

    def write_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def handle_events(self, parsed):
        query = parse_qs(parsed.query)
        mode = query.get("mode", ["public"])[0]
        auth = {
            "pin": query.get("pin", [""])[0],
            "playerId": query.get("playerId", [""])[0],
            "secret": query.get("secret", [""])[0],
        }
        client = {"queue": queue.Queue(maxsize=5), "mode": mode, "auth": auth}
        STORE.add_client(client)
        client["queue"].put(STORE.snapshot(mode, auth))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            while True:
                try:
                    payload = client["queue"].get(timeout=15)
                    data = json.dumps(payload, ensure_ascii=False)
                    self.wfile.write(f"event: state\ndata: {data}\n\n".encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass
        finally:
            STORE.remove_client(client)

    def serve_static(self, path):
        if path in ("", "/"):
            file_path = STATIC_DIR / "index.html"
        else:
            safe_path = path.lstrip("/").replace("/", os.sep)
            file_path = BASE_DIR / safe_path
        try:
            resolved = file_path.resolve()
            if STATIC_DIR not in resolved.parents and resolved != STATIC_DIR / "index.html":
                raise FileNotFoundError
            if not resolved.exists() or not resolved.is_file():
                raise FileNotFoundError
            content_type = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
            data = resolved.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        except FileNotFoundError:
            self.send_error(404, "Not found")


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), RequestHandler)
    print("Blood on the Clocktower 서버가 시작되었습니다.", flush=True)
    print(f"스토리텔러 PIN: {HOST_PIN}", flush=True)
    print("접속 주소:", flush=True)
    for url in get_lan_urls():
        print(f"  {url}", flush=True)
    print("종료하려면 이 창에서 Ctrl+C를 누르세요.", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
