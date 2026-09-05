// SPDX-License-Identifier: Apache-2.0
//
// B3V4 fast-path helper — timing measurements.

import type { TimingMeasurements } from "./types.js";

export interface TimingEvent {
  name: string;
  timestampMs: number;
}

export class TimingRecorder {
  private events: TimingEvent[] = [];

  record(name: string, timestampMs: number = Date.now()): void {
    this.events.push({ name, timestampMs });
  }

  getEvent(name: string): TimingEvent | undefined {
    return this.events.find((e) => e.name === name);
  }

  msBetween(from: string, to: string): number | undefined {
    const a = this.getEvent(from);
    const b = this.getEvent(to);
    if (a === undefined || b === undefined) return undefined;
    return b.timestampMs - a.timestampMs;
  }

  toMeasurements(acceptName: string = "accept"): TimingMeasurements {
    // Try the specified name first, then fall back to "execute-start"
    const accept = this.getEvent(acceptName) ?? this.getEvent("execute-start");
    if (accept === undefined) return {};

    const timings: TimingMeasurements = {};

    const offerPublish = this.getEvent("offer-publish");
    if (offerPublish !== undefined) {
      timings.offerPublishToAcceptMs = accept.timestampMs - offerPublish.timestampMs;
    }

    const roomReady = this.getEvent("room-ready");
    if (roomReady !== undefined) {
      timings.acceptToRoomReadyMs = roomReady.timestampMs - accept.timestampMs;
    }

    const paperLock = this.getEvent("paper-lock");
    if (paperLock !== undefined) {
      timings.acceptToPaperLockMs = paperLock.timestampMs - accept.timestampMs;
    }

    const lockFrame = this.getEvent("lock-frame");
    if (lockFrame !== undefined) {
      timings.acceptToLockFrameMs = lockFrame.timestampMs - accept.timestampMs;
    }

    const mailboxWake = this.getEvent("mailbox-wake");
    if (mailboxWake !== undefined) {
      timings.acceptToMailboxWakeMs = mailboxWake.timestampMs - accept.timestampMs;
    }

    const end = this.getEvent("end");
    if (end !== undefined) {
      timings.totalMs = end.timestampMs - accept.timestampMs;
    }

    return timings;
  }

  allEvents(): TimingEvent[] {
    return [...this.events];
  }
}
