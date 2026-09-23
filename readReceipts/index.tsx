/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, MessageStore, React, UserStore } from "@webpack/common";

// Discord channel types: 0 = guild text, 1 = DM, 3 = group DM.
const ChannelType = {
    DM: 1,
    GROUP_DM: 3,
} as const;

interface ViewerInfo {
    userId: string;
    /** Wall-clock time (ms) when this user was last observed active. */
    at: number;
    /** ID of the newest own message that existed when the activity was seen. */
    seenUpToId: string;
}

/** channelId -> (userId -> activity). Supports many viewers for servers. */
const seenMap = new Map<string, Map<string, ViewerInfo>>();

const MAX_VIEWERS_PER_CHANNEL = 100;

// --- tiny pub/sub so accessories re-render when `seenMap` changes ---------
const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}
function emit() {
    listeners.forEach(l => {
        try { l(); } catch { /* ignore */ }
    });
}

function getCurrentUserId(): string | undefined {
    try {
        return UserStore.getCurrentUser()?.id;
    } catch {
        return undefined;
    }
}

function getChannel(channelId: string): any {
    try {
        return ChannelStore.getChannel(channelId);
    } catch {
        return undefined;
    }
}

function isGuildChannel(channelId: string): boolean {
    try {
        return !!getChannel(channelId)?.guild_id;
    } catch {
        return false;
    }
}

function isBot(userId: string): boolean {
    try {
        return !!UserStore.getUser(userId)?.bot;
    } catch {
        return false;
    }
}

function shouldTrackChannel(channelId: string): boolean {
    const channel = getChannel(channelId);
    if (!channel) return false;
    if (channel.guild_id) return settings.store.enableServers;
    if (channel.type === ChannelType.DM) return settings.store.enableDMs;
    if (channel.type === ChannelType.GROUP_DM) return settings.store.enableGroupDMs;
    return false;
}

function getMessagesArray(channelId: string): any[] {
    try {
        const msgs = MessageStore.getMessages(channelId);
        if (!msgs) return [];
        if (Array.isArray(msgs)) return msgs;
        if (typeof (msgs as any).toArray === "function") return (msgs as any).toArray();
        if (Array.isArray((msgs as any)._array)) return (msgs as any)._array;
        if (typeof msgs === "object") return Object.values(msgs);
        return [];
    } catch {
        return [];
    }
}

function getLastOwnMessage(channelId: string, myId: string): any | undefined {
    const arr = getMessagesArray(channelId);
    for (let i = arr.length - 1; i >= 0; i--) {
        const m = arr[i];
        if (m?.author?.id === myId) return m;
    }
    return undefined;
}

function getLastMessage(channelId: string): any | undefined {
    const arr = getMessagesArray(channelId);
    return arr.length ? arr[arr.length - 1] : undefined;
}

function toMs(t: unknown, fallback: number): number {
    if (typeof t === "number") {
        // Gateway typing timestamps are in seconds; message timestamps are ms/ISO.
        return t < 1e12 ? t * 1000 : t;
    }
    if (typeof t === "string") {
        const p = Date.parse(t);
        return Number.isNaN(p) ? fallback : p;
    }
    return fallback;
}

function snowflakeGte(a: string, b: string): boolean {
    try {
        return BigInt(a) >= BigInt(b);
    } catch {
        return a >= b;
    }
}

/**
 * Record that `byUserId` was active in `channelId` at `activityAtMs`, which
 * implies they saw everything up to our newest message there.
 */
function markSeen(channelId: string, byUserId: string, activityAtMs: number) {
    const myId = getCurrentUserId();
    if (!myId || byUserId === myId) return;
    if (isBot(byUserId)) return;
    if (!shouldTrackChannel(channelId)) return;

    const lastOwn = getLastOwnMessage(channelId, myId);
    if (!lastOwn?.id) return;

    const ownTs = toMs(lastOwn.timestamp ?? lastOwn.edited_timestamp, 0);
    // Ignore stale activity (e.g. a typing event that started before my message).
    if (ownTs && activityAtMs + 5000 < ownTs) return;

    let viewers = seenMap.get(channelId);
    if (!viewers) {
        viewers = new Map();
        seenMap.set(channelId, viewers);
    }

    const prev = viewers.get(byUserId);
    if (prev && snowflakeGte(prev.seenUpToId, String(lastOwn.id)) && prev.at >= activityAtMs) return;

    viewers.set(byUserId, {
        userId: byUserId,
        at: activityAtMs,
        seenUpToId: String(lastOwn.id),
    });

    // Bound memory in very busy channels: drop the least-recent viewers.
    if (viewers.size > MAX_VIEWERS_PER_CHANNEL) {
        const sorted = [...viewers.values()].sort((a, b) => a.at - b.at);
        for (let i = 0; i < viewers.size - MAX_VIEWERS_PER_CHANNEL; i++) {
            viewers.delete(sorted[i].userId);
        }
    }

    emit();
}

/**
 * Everyone (bots excluded) whose observed activity covers `messageId`,
 * most-recent first.
 */
function getViewersForMessage(channelId: string, messageId: string): ViewerInfo[] {
    const viewers = seenMap.get(channelId);
    if (!viewers) return [];
    return [...viewers.values()]
        .filter(v => !isBot(v.userId) && snowflakeGte(v.seenUpToId, messageId))
        .sort((a, b) => b.at - a.at);
}

function getPeerId(channelId: string, fallbackId?: string): string | undefined {
    if (fallbackId) return fallbackId;
    try {
        const channel = getChannel(channelId);
        const recipients: string[] | undefined = channel?.recipients ?? channel?.rawRecipients?.map?.((r: any) => r?.id);
        const myId = getCurrentUserId();
        const peer = recipients?.find(id => id !== myId);
        return peer ?? recipients?.[0];
    } catch {
        return undefined;
    }
}

function getAvatarUrl(userId: string): string | undefined {
    try {
        const user = UserStore.getUser(userId);
        if (!user) return undefined;
        if (typeof user.getAvatarURL === "function") {
            try {
                const url = user.getAvatarURL(false, 32);
                if (url) return url;
            } catch { /* fall through */ }
        }
        if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=32`;
        const disc = Number(user.discriminator ?? 0);
        return `https://cdn.discordapp.com/embed/avatars/${Number.isNaN(disc) ? 0 : disc % 5}.png`;
    } catch {
        return undefined;
    }
}

function ServerReceipt({ channelId, messageId }: { channelId: string; messageId: string; }) {
    const viewers = getViewersForMessage(channelId, messageId);
    if (!viewers.length) {
        if (!settings.store.showSent) return null;
        return (
            <div className="vc-rr-container vc-rr-sent">
                <span className="vc-rr-text">{settings.store.sentText || "Sent"}</span>
            </div>
        );
    }

    const max = Number(settings.store.serverMaxAvatars) || 5;
    const shown = settings.store.showAvatar ? viewers.slice(0, max) : [];
    const overflow = viewers.length - shown.length;

    return (
        <div className="vc-rr-container vc-rr-seen">
            <span className="vc-rr-text">{settings.store.serverSeenText || "Seen by"} {viewers.length}</span>
            {shown.length > 0 && (
                <span className="vc-rr-avatars">
                    {shown.map(v => {
                        const url = getAvatarUrl(v.userId);
                        return url
                            ? <img key={v.userId} className="vc-rr-avatar" src={url} alt="" aria-hidden="true" />
                            : null;
                    })}
                    {overflow > 0 && <span className="vc-rr-more">+{overflow}</span>}
                </span>
            )}
        </div>
    );
}

function DmReceipt({ channelId, messageId }: { channelId: string; messageId: string; }) {
    const viewers = getViewersForMessage(channelId, messageId);
    if (!viewers.length) {
        if (!settings.store.showSent) return null;
        return (
            <div className="vc-rr-container vc-rr-sent">
                <span className="vc-rr-text">{settings.store.sentText || "Sent"}</span>
            </div>
        );
    }

    // In a 1:1 DM there is normally one viewer; in group DMs take the latest.
    const latest = viewers[0];
    const peerId = getPeerId(channelId, latest.userId);
    const avatar = settings.store.showAvatar && peerId ? getAvatarUrl(peerId) : undefined;
    return (
        <div className="vc-rr-container vc-rr-seen">
            <span className="vc-rr-text">{settings.store.seenText || "Seen"}</span>
            {settings.store.showTimestamp && (
                <span className="vc-rr-time">
                    {new Date(latest.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </span>
            )}
            {avatar && <img className="vc-rr-avatar" src={avatar} alt="" aria-hidden="true" />}
        </div>
    );
}

function SeenInner({ message }: { message: any; }) {
    const [, setTick] = React.useState(0);
    React.useEffect(() => subscribe(() => setTick(t => t + 1)), []);

    const myId = getCurrentUserId();
    if (!myId || message?.author?.id !== myId) return null;

    const channelId: string | undefined = message?.channel_id;
    if (!channelId || !shouldTrackChannel(channelId)) return null;

    // Instagram behaviour: the receipt lives on the last message only.
    if (settings.store.onlyLastMessage) {
        const last = getLastMessage(channelId);
        if (!last || String(last.id) !== String(message.id)) return null;
    } else {
        // Otherwise still require that no *newer* message exists after this one
        // in the loaded history before showing anything.
        const arr = getMessagesArray(channelId);
        const idx = arr.findIndex(m => String(m?.id) === String(message.id));
        if (idx !== -1 && idx !== arr.length - 1) {
            const newer = arr.slice(idx + 1);
            // If someone else wrote after me, the conversation moved on.
            if (newer.some(m => m?.author?.id !== myId)) return null;
        }
    }

    const messageId = String(message.id);
    return isGuildChannel(channelId)
        ? <ServerReceipt channelId={channelId} messageId={messageId} />
        : <DmReceipt channelId={channelId} messageId={messageId} />;
}

const settings = definePluginSettings({
    enableDMs: {
        type: OptionType.BOOLEAN,
        description: "Show read receipts in 1:1 DMs",
        default: true,
    },
    enableGroupDMs: {
        type: OptionType.BOOLEAN,
        description: "Also show read receipts in group DMs (experimental: receipt reflects the most recent active member)",
        default: false,
    },
    enableServers: {
        type: OptionType.BOOLEAN,
        description: "Show read receipts in servers (\"Seen by N\" with avatars, estimated from member activity)",
        default: true,
    },
    onlyLastMessage: {
        type: OptionType.BOOLEAN,
        description: "Only show the receipt under the last message (like Instagram)",
        default: true,
    },
    showSent: {
        type: OptionType.BOOLEAN,
        description: "Show a \"Sent\" label under your last message until it is seen",
        default: true,
    },
    seenText: {
        type: OptionType.STRING,
        description: "Text shown when your DM has been seen",
        default: "Seen",
    },
    sentText: {
        type: OptionType.STRING,
        description: "Text shown before your message has been seen",
        default: "Sent",
    },
    serverSeenText: {
        type: OptionType.STRING,
        description: "Prefix shown before the viewer count in servers",
        default: "Seen by",
    },
    serverMaxAvatars: {
        type: OptionType.SELECT,
        description: "Maximum member avatars shown next to the server Seen count",
        options: [
            { label: "3", value: 3, default: false },
            { label: "5", value: 5, default: true },
            { label: "8", value: 8, default: false },
        ],
    },
    showAvatar: {
        type: OptionType.BOOLEAN,
        description: "Show avatars next to the Seen label (like Instagram)",
        default: true,
    },
    showTimestamp: {
        type: OptionType.BOOLEAN,
        description: "Show the time the DM was seen (DMs only)",
        default: false,
    },
});

export default definePlugin({
    name: "ReadReceipts",
    description: "Instagram-style read receipts: Seen + avatar in DMs, Seen-by count + avatars in servers. Note: Discord has no real read API, so Seen is estimated from observed activity (replies, typing, reactions, edits).",
    authors: [{ name: "embabyty", id: 42676826n }],
    settings,

    flux: {
        MESSAGE_CREATE({ message }: any) {
            try {
                if (!message?.channel_id || !message?.author?.id) return;
                if (message.author?.bot) return;
                const channelId = String(message.channel_id);
                if (!shouldTrackChannel(channelId)) return;
                const myId = getCurrentUserId();
                if (!myId) return;
                if (message.author.id === myId) {
                    // My new message: refresh so the receipt moves to it.
                    emit();
                } else {
                    markSeen(channelId, String(message.author.id), toMs(message.timestamp, Date.now()));
                }
            } catch { /* ignore */ }
        },

        MESSAGE_UPDATE({ message }: any) {
            try {
                if (!message?.channel_id || !message?.author?.id) return;
                if (message.author?.bot) return;
                const channelId = String(message.channel_id);
                if (!shouldTrackChannel(channelId)) return;
                const myId = getCurrentUserId();
                if (!myId || message.author.id === myId) return;
                markSeen(channelId, String(message.author.id), toMs(message.edited_timestamp ?? message.timestamp, Date.now()));
            } catch { /* ignore */ }
        },

        TYPING_START(data: any) {
            try {
                const channelId = String(data?.channelId ?? data?.channel_id ?? "");
                const userId = String(data?.userId ?? data?.user_id ?? "");
                if (!channelId || !userId) return;
                if (!shouldTrackChannel(channelId)) return;
                markSeen(channelId, userId, toMs(data?.timestamp, Date.now()));
            } catch { /* ignore */ }
        },

        MESSAGE_REACTION_ADD(data: any) {
            try {
                const channelId = String(data?.channelId ?? data?.channel_id ?? "");
                const userId = String(data?.userId ?? data?.user_id ?? "");
                if (!channelId || !userId) return;
                if (!shouldTrackChannel(channelId)) return;
                markSeen(channelId, userId, Date.now());
            } catch { /* ignore */ }
        },
    },

    renderMessageAccessory(props: any) {
        if (!props?.message) return null;
        return (
            <ErrorBoundary noop>
                <SeenInner message={props.message} />
            </ErrorBoundary>
        );
    },

    start() { },
    stop() {
        seenMap.clear();
        emit();
    },
});
