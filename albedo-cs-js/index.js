// albedo-cs-js: A reference Albedo Central Station implementation in JavaScript
// Copyright (C) 2026 Logan Devine <logan@zirco.dev>
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import "dotenv/config";
import mx from "matrix-js-sdk";

const ROUND_TIMEOUT_MS = 45000; // 45 seconds is ample time for all servers to respond to pongs.
const ROUND_INTERVAL_MS = 60000; // Run a round every 60 seconds.
const CYCLE_MIN_INTERVAL_MS = 15 * 60 * 1000; // Wait at least 15 minutes between full "cycles" (A-Z through the roster) to avoid excessive load on servers.
const SERVER_KICK_THRESHOLD = 3; // If a server times out (doesn't pong) for 3 consecutive rounds, remove it from the roster.

const HOMESERVER_URL = process.env.HOMESERVER_URL;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const USER_ID = process.env.USER_ID;
const ROOM_ID = process.env.ROOM_ID;
const ADMIN_MXID = process.env.ADMIN_MXID;
const serverFromMxid = (mxid) => mxid.split(":").slice(1).join(":");
const SERVER_NAME = serverFromMxid(USER_ID);

if (!HOMESERVER_URL || !ACCESS_TOKEN || !USER_ID || !ROOM_ID || !ADMIN_MXID) {
    console.error(
        "Missing required environment variables. Please set HOMESERVER_URL, ACCESS_TOKEN, USER_ID, ADMIN_MXID, and ROOM_ID.",
    );
    process.exit(1);
}

const client = mx.createClient({
    baseUrl: HOMESERVER_URL,
    accessToken: ACCESS_TOKEN,
    userId: USER_ID,
});

console.log("Starting Albedo Central Station...");

client.startClient();

client.once(mx.ClientEvent.Sync, async (state) => {
    if (state === "PREPARED") {
        console.log("Client synced and ready.");

        // Publish the empty roster to force listening PNs to register.
        await publishRoster();

        if (!client.getRoom(ROOM_ID)) {
            console.log(
                `Not currently in room ${ROOM_ID}, attempting to join...`,
            );
            joinRoom(ROOM_ID).then((ok) => { if (ok) publishRoster(); });
        }
    }
});
client.on(mx.RoomEvent.MyMembership, (room, membership, prevMembership) => {
    if (
        (membership === mx.KnownMembership.Invite && room.roomId === ROOM_ID) ||
        room.getDMInviter() === ADMIN_MXID
    ) {
        console.log(`Invited to room ${room.roomId}, attempting to join...`);
        joinRoom(room.roomId).then((ok) => { if (ok && room.roomId === ROOM_ID) publishRoster(); });
    }
});

// The current list of ping rounds in progress, keyed by round ID.
/** @type {Record<string, {server: string, pongs: Record<string, number>}>} */
const roundsInFlight = {};

// A list of servers which have timed out in recent rounds and how many rounds they have timed out for.
// Any server timing out for at least SERVER_KICK_THRESHOLD consecutive rounds will be removed from the roster.
/** @type {Record<string, number>} */
const gettingOnMyNerves = {};

// The current roster state. This is the canonical source of truth for the roster.
// After updating this, a new roster should be published.
let roster = new Set();
let serverInfo = {};
async function publishRoster() {
    const room = client.getRoom(ROOM_ID);
    if (!room) {
        console.error(`Cannot publish roster: not in room ${ROOM_ID}.`);
        return;
    }

    try {
        await client.sendStateEvent(
            ROOM_ID,
            "dev.zirco.albedo.roster",
            { participants: Array.from(roster) },
            "",
        );
        console.log("Published roster:", Array.from(roster));
    } catch (e) {
        console.error("Failed to publish roster:", e);
    }
}

const isParticipant = (server) => roster.has(server);
const eventSender = (event) => serverFromMxid(event.getSender());

async function setUserPowerLevel(userMxid, level) {
    const content = (await client.getStateEvent(ROOM_ID, "m.room.power_levels", "")) || {};
    if (!content.users) content.users = {};
    content.users[userMxid] = level;
    await client.sendStateEvent(ROOM_ID, "m.room.power_levels", content, "");
}

async function joinRoom(roomId) {
    try {
        await client.joinRoom(roomId);
        console.log(`Successfully joined room ${roomId}.`);
        return true;
    } catch (err) {
        console.error(`Failed to join room ${roomId}:`, err);
        return false;
    }
}

// Event senders
async function sendRegisterReject(user, code, reason) {
    await client.sendEvent(ROOM_ID, "dev.zirco.albedo.register.reject", {
        user,
        code,
        reason,
    });
    console.log(`Sent registration rejection to ${user}: ${code} ${reason}`);
}
async function sendRoundStart(server, id) {
    await client.sendEvent(ROOM_ID, "dev.zirco.albedo.round.start", {
        server,
        id,
    });
    console.log(`Sent round start for ${server} with id ${id}`);
}
async function sendRoundComplete(server, id, pongs) {
    await client.sendEvent(ROOM_ID, "dev.zirco.albedo.round.complete", {
        ping_server: server,
        id,
        pongs,
    });
    console.log(`Sent round complete for ${server} with id ${id}`);
}

// EVENT HANDLER
client.on(mx.RoomEvent.Timeline, async (event, room, toStartOfTimeline) => {
    if (toStartOfTimeline) return; // Ignore old events when syncing.
    if (event.getAge() > 60000) return; // Ignore events older than 60 seconds.

    if (room.roomId !== ROOM_ID) return; // Ignore events from other rooms.

    const senderServer = eventSender(event);

    if (event.getType() === "dev.zirco.albedo.register") {
        console.log(`Received registration request from ${senderServer}.`);
        if (isParticipant(senderServer)) {
            console.warn(
                `Server ${senderServer} is already registered, sending reject.`,
            );
            await sendRegisterReject(
                senderServer,
                "already_registered",
                "This server is already registered.",
            );
        } else {
            // TODO: Blocklisting
            // Give the new participant PL 20
            await setUserPowerLevel(event.getSender(), 20);

            roster.add(senderServer);
            serverInfo[senderServer] = event.getContent();
            await publishRoster();
            console.log(`Registered server ${senderServer}.`);
        }
    } else if (event.getType() === "dev.zirco.albedo.leave") {
        console.log(`Received leave event from ${senderServer}.`);
        if (isParticipant(senderServer)) {
            // Set the leaving participant's PL to 10 to revoke their permissions.
            await setUserPowerLevel(event.getSender(), 10);

            roster.delete(senderServer);
            delete serverInfo[senderServer];
            await publishRoster();
            console.log(`Removed server ${senderServer} from roster.`);
        } else {
            console.warn(
                `Received leave event from ${senderServer} but it is not registered.`,
            );
        }
    } else if (event.getType() === "dev.zirco.albedo.pong") {
        console.log(`Received pong from ${senderServer}.`);
        const content = event.getContent();
        const { id, ping_server: pingServer, ms } = content;
        const pongServer = eventSender(event);

        if (!isParticipant(pongServer)) {
            console.warn(
                `Received pong from ${pongServer} but it is not registered, ignoring.`,
            );
            return;
        }

        if (!roundsInFlight[id]) {
            console.warn(
                `Received pong with id ${id} but no such round is in flight, ignoring.`,
            );
            return;
        }

        if (roundsInFlight[id].server !== pingServer) {
            console.warn(
                `Received pong for ping server ${pingServer} but round ${id} is for ping server ${roundsInFlight[id].server}, ignoring.`,
            );
            return;
        }

        roundsInFlight[id].pongs[pongServer] = ms;
        console.log(
            `Recorded pong from ${pongServer} for round ${id} with latency ${ms}ms.`,
        );

        // Check if we have received pongs from all participants.
        const expectedPongs = roster.size - 1; // Exclude the ping server itself.
        const receivedPongs = Object.keys(roundsInFlight[id].pongs).length;

        if (receivedPongs === expectedPongs) {
            console.log(
                `Received all pongs for round ${id}, sending round complete.`,
            );
            await sendRoundComplete(pingServer, id, roundsInFlight[id].pongs);
            delete roundsInFlight[id];
        }
    }
});

client.on(mx.RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
    if (toStartOfTimeline) return;
    if (event.getAge() > 60000) return; // Ignore events older than 60 seconds because they may be stale.
    // We listen for admin commands in any room, as long as they are sent by the admin user.
    if (event.getSender() !== ADMIN_MXID) return;

    // text message commands:
    if (
        event.getType() === "m.room.message" &&
        event.getContent().msgtype === "m.text"
    ) {
        const body = event.getContent().body.trim();
        if (body === "!acs roster") {
            const rosterList = Array.from(roster).join(", ");
            client.sendNotice(room.roomId, `Current roster: ${rosterList}`);
        } else if (body.startsWith("!acs kick ")) {
            const serverToKick = body.slice("!acs kick ".length).trim();
            if (!isParticipant(serverToKick)) {
                client.sendNotice(
                    room.roomId,
                    `Server ${serverToKick} is not in the roster.`,
                );
                return;
            }

            // Set the kicked participant's PL to 10 to revoke their permissions.
            const participantMxid = Object.keys(serverInfo).find(
                (mxid) => serverInfo[mxid].server === serverToKick,
            );
            if (participantMxid) {
                setUserPowerLevel(participantMxid, 10);
                roster.delete(serverToKick);
                delete serverInfo[serverToKick];
                publishRoster();
                client.sendNotice(
                    room.roomId,
                    `Kicked server ${serverToKick} from the roster.`,
                );
                console.log(
                    `Kicked server ${serverToKick} from the roster by admin command.`,
                );
            } else {
                client.sendNotice(
                    room.roomId,
                    `Could not find MXID for server ${serverToKick}, cannot kick.`,
                );
                console.error(
                    `Could not find MXID for server ${serverToKick}, cannot kick.`,
                );
            }
        }
    }
});

async function beginRound(server) {
    const roundId = crypto.randomUUID();
    roundsInFlight[roundId] = { server, pongs: {} };
    await sendRoundStart(server, roundId);
    console.log(`Began round ${roundId} for server ${server}.`);

    setTimeout(async () => {
        if (roundsInFlight[roundId]) {
            console.warn(
                `Round ${roundId} for server ${server} timed out, sending round complete with received pongs.`,
            );

            // add nulls for missing pongs
            const expectedPongs = roster.size - 1; // Exclude the ping server itself.
            const receivedPongs = Object.keys(
                roundsInFlight[roundId].pongs,
            ).length;
            if (receivedPongs < expectedPongs) {
                console.warn(
                    `Round ${roundId} for server ${server} is missing ${expectedPongs - receivedPongs} pongs.`,
                );
                roster.forEach((participant) => {
                    if (
                        participant !== server &&
                        !roundsInFlight[roundId].pongs[participant]
                    ) {
                        roundsInFlight[roundId].pongs[participant] = null;
                        console.warn(
                            `Round ${roundId} for server ${server} is missing pong from ${participant}, recording as null.`,
                        );

                        // Increment the timeout count for this participant.
                        gettingOnMyNerves[participant] = (gettingOnMyNerves[participant] || 0) + 1;

                        console.warn(
                            `Server ${participant} has now timed out for ${gettingOnMyNerves[participant]} consecutive rounds.`,
                        );

                        // If this participant has timed out for too many consecutive rounds, remove it from the roster.
                        if (
                            gettingOnMyNerves[participant] >=
                            SERVER_KICK_THRESHOLD
                        ) {
                            console.warn(
                                `Server ${participant} has timed out for ${gettingOnMyNerves[participant]} consecutive rounds, removing from roster.`,
                            );
                            roster.delete(participant);
                            delete serverInfo[participant];
                            publishRoster();
                            delete gettingOnMyNerves[participant];
                        }
                    }
                });
            }

            await sendRoundComplete(
                server,
                roundId,
                roundsInFlight[roundId].pongs,
            );
            delete roundsInFlight[roundId];
        }
    }, ROUND_TIMEOUT_MS);
}

// Every ROUND_INTERVAL_MS, start a new round for each participant in the roster.
// Once we finish the roster, if we haven't already, we should wait at least CYCLE_MIN_INTERVAL_MS before starting the next round of the roster to avoid excessive load on servers.
let lastCycleTime = 0;
let rosterIndex = 0;
setInterval(() => {
    if (roster.size === 0) {
        console.log("Roster is empty, skipping round.");
        return;
    }

    const now = Date.now();
    if (now - lastCycleTime < CYCLE_MIN_INTERVAL_MS) {
        console.log(
            `Last cycle was ${Math.round(
                (now - lastCycleTime) / 1000,
            )} seconds ago, waiting before starting next cycle.`,
        );
        return;
    }

    const participants = Array.from(roster);
    const server = participants[rosterIndex % participants.length];
    beginRound(server);

    rosterIndex++;
    if (rosterIndex % participants.length === 0) {
        lastCycleTime = now;
        console.log(
            `Completed a full cycle through the roster, waiting at least ${
                CYCLE_MIN_INTERVAL_MS / 1000
            } seconds before starting the next cycle.`,
        );
    }
}, ROUND_INTERVAL_MS);
