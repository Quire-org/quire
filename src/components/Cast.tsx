import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import qrcode from "qrcode-generator";
import { DeviceMobile, Prohibit, ShieldCheck, Stop, Warning } from "@phosphor-icons/react";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { useStore } from "../store";
import { api, mediaUrl, rawPreviewUrl } from "../lib/api";
import { loadImage } from "../lib/dupes";
import type { MediaItem } from "../lib/types";

/**
 * Showing on another device: what the viewer shows, on a phone or tablet in its browser (the
 * server is the backend's `cast`). Off until started; each device is let in here; it is only ever
 * sent the picture shown now, as a screen-sized JPEG drawn here (never a file), or the video shown
 * now, streamed as it plays and only while it is shown; Stop ends it.
 */

export interface CastUrl {
  iface: string;
  url: string;
}
export interface CastInfo {
  urls: CastUrl[];
  fingerprint: string;
}
export interface CastDevice {
  id: string;
  name: string;
  ip: string;
  state: "pending" | "allowed" | "denied";
}

interface CastStore {
  info: CastInfo | null;
  devices: CastDevice[];
  /** Devices may go back and forth (else they only follow the Mac). */
  remote: boolean;
  panel: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  decide(id: string, allow: boolean): Promise<void>;
  setRemote(on: boolean): Promise<void>;
}

export const useCast = create<CastStore>((set, get) => ({
  info: null,
  devices: [],
  remote: true,
  panel: false,
  async start() {
    try {
      const info = await api.castStart(get().remote);
      set({ info, devices: [] });
      lastSent = "";
    } catch (e) {
      useStore.getState().toast(`Couldn't start showing: ${String(e)}`, "error");
    }
  },
  async stop() {
    await api.castStop().catch(() => {});
    set({ info: null, devices: [] });
  },
  async decide(id, allow) {
    await api.castDecide(id, allow).catch(() => {});
    set({ devices: get().devices.map((d) => (d.id === id ? { ...d, state: allow ? "allowed" : "denied" } : d)) });
  },
  async setRemote(on) {
    set({ remote: on });
    if (get().info) await api.castRemote(on).catch(() => {});
  },
}));

/** Pictures are sent at most this many pixels on their long side: a screen's worth, never the file. */
export const CAST_SIDE = 2048;

let seq = 0;
let lastSent = "";

/** A picture as the device gets it: drawn here at screen size, as a JPEG (base64). */
export async function castJpeg(item: MediaItem): Promise<string> {
  const url = item.kind === "raw" ? await rawPreviewUrl(item.primary) : mediaUrl(item);
  const img = await loadImage(url);
  const k = Math.min(1, CAST_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("couldn't make the picture"))), "image/jpeg", 0.85));
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(",") + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** What the viewer shows now (nothing on other screens). */
function shownNow(): { item: MediaItem | null; index: number; total: number } {
  const s = useStore.getState();
  const item = s.screen === "viewer" ? (s.queue[s.index] ?? null) : null;
  return { item, index: s.index, total: s.queue.length };
}

/** The picture shown now, to the devices, when it changed. A newer one going out drops an older one still being made. */
export async function sendShown(force = false): Promise<void> {
  if (!useCast.getState().info) return;
  const { item, index, total } = shownNow();
  const sig = item ? `${item.key}|${item.modified}|${index}|${total}` : "";
  if (!force && sig === lastSent) return;
  lastSent = sig;
  const mine = ++seq;
  if (!item) return void (await api.castFrame(mine, null, "", false, 0, 0, true).catch(() => {}));
  // A video streams from its file as the device plays it (the backend reads it, from a vault too).
  if (item.kind === "video") return void (await api.castFrame(mine, null, item.name, true, index, total, false, item.primary, useStore.getState().root).catch(() => {}));
  try {
    const jpeg = await castJpeg(item);
    if (mine !== seq) return;
    await api.castFrame(mine, jpeg, item.name, false, index, total, false);
  } catch {
    if (mine === seq) await api.castFrame(mine, null, item.name, false, index, total, true).catch(() => {});
  }
}

/**
 * Always there while showing: keeps the devices on what the viewer shows, asks about each new device,
 * goes back and forth when a device asks to, and stops when the library closes.
 */
export function CastHost() {
  const info = useCast((x) => x.info);
  const devices = useCast((x) => x.devices);
  const panel = useCast((x) => x.panel);
  const root = useStore((x) => x.root);

  // What is shown now goes out as it changes.
  useEffect(() => {
    if (!info) return;
    void sendShown(true);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useStore.subscribe((s, p) => {
      if (s.queue === p.queue && s.index === p.index && s.screen === p.screen) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void sendShown(), 120);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [info]);

  // Who is there, and where they asked to go.
  useEffect(() => {
    if (!info) return;
    let alive = true;
    const tick = async () => {
      const st = await api.castStatus().catch(() => null);
      if (!alive || !st) return;
      if (!st.running) {
        useCast.setState({ info: null, devices: [] });
        return;
      }
      useCast.setState({ devices: st.devices });
      const s = useStore.getState();
      if (s.screen === "viewer") for (const dir of st.nav) dir > 0 ? s.next() : s.prev();
    };
    void tick();
    const t = setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [info]);

  // Another library (or none): showing ends.
  useEffect(() => {
    return () => void (useCast.getState().info && useCast.getState().stop());
  }, [root]);

  const waiting = devices.filter((d) => d.state === "pending");
  return (
    <>
      {info && !panel && waiting.length > 0 && (
        <div className="cast-ask panel">
          {waiting.map((d) => (
            <DeviceAsk key={d.id} d={d} />
          ))}
        </div>
      )}
      {panel && <CastPanel />}
    </>
  );
}

function DeviceAsk({ d }: { d: CastDevice }) {
  const decide = useCast((x) => x.decide);
  return (
    <div className="cast-device">
      <DeviceMobile />
      <span className="grow">
        <b>{d.name}</b> <span className="dim small mono">{d.ip}</span>
        <div className="small dim">wants to see what you show</div>
      </span>
      <button className="btn sm ghost" onClick={() => void decide(d.id, false)} title="It can't ask again from there while this runs">
        <Prohibit /> Turn down
      </button>
      <button className="btn sm primary" onClick={() => void decide(d.id, true)}>
        Allow
      </button>
    </div>
  );
}

/** The QR code of a link, drawn as squares: black on white whatever the theme, so phones read it. */
function Qr({ text }: { text: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const out: string[] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) out.push(`M${c + 4},${r + 4}h1v1h-1z`);
    return { n: n + 8, d: out.join("") };
  }, [text]);
  return (
    <svg className="cast-qr" viewBox={`0 0 ${cells.n} ${cells.n}`} shapeRendering="crispEdges" role="img" aria-label="QR code of the link">
      <rect width={cells.n} height={cells.n} fill="#fff" />
      <path d={cells.d} fill="#000" />
    </svg>
  );
}

const hostOf = (u: CastUrl) => u.url.split("/")[2].split(":")[0];
/** On an iPhone's Personal Hotspot (it always hands out 172.20.10.x), or this Mac's own shared connection: only your devices are on it. */
const yours = (u: CastUrl) => hostOf(u).startsWith("172.20.10.") || /^(bridge|ap)/.test(u.iface);
const rank = (u: CastUrl) => (yours(u) ? 0 : /^en/.test(u.iface) ? 1 : 2);
const label = (u: CastUrl) => (hostOf(u).startsWith("172.20.10.") ? "an iPhone's hotspot" : /^bridge/.test(u.iface) ? "this Mac's shared connection" : u.iface === "en0" ? "Wi-Fi" : u.iface);

export function CastPanel() {
  const c = useCast();
  const [which, setWhich] = useState(0);
  const urls = useMemo(() => [...(c.info?.urls ?? [])].sort((a, b) => rank(a) - rank(b)), [c.info]);
  const url = urls[Math.min(which, urls.length - 1)];
  const close = () => useCast.setState({ panel: false });
  return (
    <Modal title="Show on another device" onClose={close}>
      <div className="cast">
        {!c.info ? (
          <>
            <div>What the viewer shows, on a phone or tablet nearby, in its browser: scan a code, allow it here, done.</div>
            <ul className="cast-safe small">
              <li>
                <ShieldCheck /> Only devices on this Mac's network, over an encrypted connection, and only those you allow here.
              </li>
              <li>
                <ShieldCheck /> Only what is shown now: a picture at screen size, never its file; a video streamed while it plays. Nothing to save on the device, and it is told to keep nothing.
              </li>
              <li>
                <ShieldCheck /> Moving on, Stop, or closing the page ends it: the link is dead, the screen wiped and the video player emptied.
              </li>
              <li className="warn">
                <Warning /> A screenshot or a photo of the screen can't be stopped by anything. Show only what you'd show anyway.
              </li>
            </ul>
            <label className="check small">
              <input type="checkbox" checked={c.remote} onChange={(e) => void c.setRemote(e.target.checked)} /> Devices can go back and forth (else they only follow this Mac)
            </label>
            <div className="row">
              <span className="grow" />
              <button className="btn primary" onClick={() => void c.start()}>
                <DeviceMobile /> Start showing
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="cast-link">
              {url && <Qr text={url.url} />}
              <div className="cast-link-text">
                <div>Scan it with the device's camera, or open the link in its browser:</div>
                <div className="mono small cast-url">{url?.url}</div>
                {urls.length > 1 && (
                  <div className="scrap-field">
                    <span className="small dim">On</span>
                    <Select compact value={String(Math.min(which, urls.length - 1))} options={urls.map((u, i) => ({ value: String(i), label: `${label(u)} (${hostOf(u)})` }))} onChange={(v) => setWhich(Number(v))} />
                  </div>
                )}
                <div className="small dim">
                  The browser warns that the connection isn't private: this Mac made its own certificate for this session. To be sure it's this Mac, its details should show this fingerprint:
                </div>
                <div className="mono small cast-fp" title={c.info.fingerprint}>
                  {c.info.fingerprint.split(" ").slice(0, 8).join(" ")} …
                </div>
              </div>
            </div>
            {url && yours(url) ? (
              <div className="small cast-warn ok">
                <ShieldCheck /> On {label(url)}: only your own devices are on it, and only those you allow here see anything.
              </div>
            ) : (
              <div className="small cast-warn">
                <Warning /> Anyone on {url ? label(url) : "this network"} can try to connect; nothing is shown until you allow them here. On a shared network (an accommodation's or a café's), join your iPhone's hotspot from this Mac and show on that instead.
              </div>
            )}
            <div className="label">Devices</div>
            <div className="cast-devices">
              {c.devices.map((d) =>
                d.state === "pending" ? (
                  <DeviceAsk key={d.id} d={d} />
                ) : (
                  <div key={d.id} className="cast-device">
                    <DeviceMobile />
                    <span className="grow">
                      <b>{d.name}</b> <span className="dim small mono">{d.ip}</span>
                    </span>
                    {d.state === "allowed" ? (
                      <>
                        <span className="small ok">watching</span>
                        <button className="btn sm ghost" onClick={() => void c.decide(d.id, false)} title="It stops seeing anything, and can't ask again from there">
                          Send away
                        </button>
                      </>
                    ) : (
                      <span className="small dim">turned down</span>
                    )}
                  </div>
                ),
              )}
              {!c.devices.length && <div className="dim small">None yet.</div>}
            </div>
            <label className="check small">
              <input type="checkbox" checked={c.remote} onChange={(e) => void c.setRemote(e.target.checked)} /> Devices can go back and forth
            </label>
            <div className="row">
              <span className="small dim grow">It shows what the viewer shows; on other screens, nothing.</span>
              <button className="btn danger" onClick={() => void c.stop()}>
                <Stop /> Stop showing
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** The button that opens it: lit while showing, with how many watch. */
export function CastButton() {
  const info = useCast((x) => x.info);
  const watching = useCast((x) => x.devices.filter((d) => d.state === "allowed").length);
  return (
    <button className={`btn sm ghost ${info ? "active" : ""}`} onClick={() => useCast.setState({ panel: true })} title={info ? `Showing on ${watching} device${watching === 1 ? "" : "s"}` : "Show on another device (a phone or tablet nearby)"}>
      <DeviceMobile />
      {info ? ` ${watching}` : ""}
    </button>
  );
}
