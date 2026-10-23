import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { Modal } from "../components/Modal";
import { formatBytes } from "../lib/format";
import type { Benchmark, DriveInfo, VerifyProgress, VerifyResult } from "../lib/types";

const BUS_LABEL: Record<string, string> = {
  sd: "SD card",
  usb: "USB device",
  nvme: "NVMe SSD",
  sata: "SATA drive",
  thunderbolt: "Thunderbolt drive",
  internal: "Internal drive",
  unknown: "Unknown bus",
};

/** Expected sequential read speeds, MB/s, to put a benchmark into context. */
function expectedSpeed(bus: string): [number, number] | null {
  switch (bus) {
    case "sd":
      return [40, 170];
    case "usb":
      return [30, 1000];
    case "nvme":
      return [1500, 7000];
    case "sata":
      return [300, 550];
    case "thunderbolt":
      return [500, 2800];
    case "internal":
      return [1500, 7000];
    default:
      return null;
  }
}

export function Drive() {
  const s = useStore();
  const [info, setInfo] = useState<DriveInfo | null>(null);
  const [bench, setBench] = useState<Benchmark | null>(null);
  const [benching, setBenching] = useState(false);
  const [verify, setVerify] = useState<VerifyProgress | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (s.root) api.driveInfo(s.root).then(setInfo).catch((e) => s.toast(String(e), "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.root]);

  const runBench = async () => {
    if (!s.root) return;
    setBenching(true);
    try {
      setBench(await api.readBenchmark(s.root));
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setBenching(false);
    }
  };

  const runVerify = async () => {
    if (!s.root) return;
    setVerifying(true);
    setVerifyResult(null);
    setVerify(null);
    try {
      setVerifyResult(await api.verifyReadability(s.root, setVerify));
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setVerifying(false);
    }
  };

  const used = info ? info.totalBytes - info.availableBytes : 0;
  const usedPct = info && info.totalBytes ? Math.round((used / info.totalBytes) * 100) : 0;
  const smart = info?.smart;
  const smartUsable = !!smart && (smart.passed != null || smart.percentUsed != null);
  const bus = info?.bus ?? "unknown";
  const exp = expectedSpeed(bus);

  // Verdict: what we can actually say.
  let verdict: { tone: "good" | "bad" | "unknown"; title: string; body: string } | null = null;
  if (info) {
    if (smartUsable) {
      const life = smart!.percentUsed != null ? 100 - smart!.percentUsed : null;
      const bad = smart!.passed === false || (smart!.reallocatedSectors ?? 0) > 0 || (smart!.pendingSectors ?? 0) > 0 || (life != null && life < 10);
      verdict = {
        tone: bad ? "bad" : "good",
        title: bad ? "Drive reports problems" : "Drive reports healthy",
        body: [
          smart!.passed != null ? `SMART self-assessment: ${smart!.passed ? "passed" : "FAILED"}.` : "",
          life != null ? `Estimated life remaining: ${life}% (wear counter).` : "",
          smart!.powerOnHours != null ? `${smart!.powerOnHours} power-on hours.` : "",
          smart!.temperatureC != null ? `${smart!.temperatureC} °C.` : "",
          (smart!.reallocatedSectors ?? 0) > 0 ? `${smart!.reallocatedSectors} reallocated sectors: back up now.` : "",
          (smart!.pendingSectors ?? 0) > 0 ? `${smart!.pendingSectors} pending sectors.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      };
    } else {
      verdict = {
        tone: "unknown",
        title: "No health counters available",
        body:
          bus === "sd"
            ? "SD cards do not expose wear or error counters to the computer, so no tool can read their remaining life. What can be checked reliably is below: read speed and whether every file is still readable."
            : info.smartctlAvailable
              ? `This device does not report SMART data through its bridge (${info.smartStatus ?? "not supported"}). Read speed and a full readability check are still reliable.`
              : "SMART data needs smartmontools (brew install smartmontools). Without it, read speed and a full readability check are still reliable.",
      };
    }
  }

  return (
    <Modal title="Drive health" onClose={() => s.set({ driveOpen: false })} wide>
      {!info ? (
        <p className="dim">Reading drive information…</p>
      ) : (
        <>
          <div className="drive-grid mono">
            <span className="label">Volume</span>
            <span>{info.mountPoint}</span>
            <span className="label">Type</span>
            <span>
              {BUS_LABEL[bus] ?? bus}
              {info.removable ? " · removable" : ""}
              {info.solidState != null ? (info.solidState ? " · solid state" : " · spinning") : ""}
            </span>
            {info.model && (
              <>
                <span className="label">Model</span>
                <span>{smart?.model ?? info.model}</span>
              </>
            )}
            <span className="label">File system</span>
            <span>{info.fileSystem ?? "?"}</span>
            <span className="label">Capacity</span>
            <span>
              {formatBytes(used)} used of {formatBytes(info.totalBytes)} ({usedPct}%), {formatBytes(info.availableBytes)} free
              <div className="cap-bar">
                <div className="cap-fill" style={{ width: `${usedPct}%`, background: usedPct > 90 ? "var(--danger)" : undefined }} />
              </div>
            </span>
            <span className="label">SMART</span>
            <span>{info.smartStatus ?? (info.smartctlAvailable ? "via smartctl" : "not available")}</span>
          </div>

          {verdict && (
            <div className={`verdict ${verdict.tone}`}>
              <h3>{verdict.title}</h3>
              <p className="dim small">{verdict.body}</p>
            </div>
          )}

          <hr className="rule" />
          <section>
            <div className="sec-head">
              <h3>Read speed</h3>
              <button className="btn sm" onClick={() => void runBench()} disabled={benching}>
                {benching ? "Reading…" : "Measure (reads ~128 MB)"}
              </button>
            </div>
            {bench ? (
              <p className="mono small">
                <span className="accent-text">{bench.mbPerS.toFixed(0)} MB/s</span> over {formatBytes(bench.bytes)} in {bench.files} files.
                {exp && (
                  <span className="dim">
                    {" "}
                    Typical for this kind of device: {exp[0]}–{exp[1]} MB/s.
                    {bench.mbPerS < exp[0] * 0.5 ? " This is well below normal; a sharp slowdown is an early sign of a tiring card or a bad reader/cable." : ""}
                  </span>
                )}
              </p>
            ) : (
              <p className="dim small">Not measured yet. Bypasses the file cache so the number reflects the drive.</p>
            )}
          </section>

          <hr className="rule" />
          <section>
            <div className="sec-head">
              <h3>Readability check</h3>
              {verifying ? (
                <button className="btn sm danger" onClick={() => void api.cancelVerify()}>
                  Cancel
                </button>
              ) : (
                <button className="btn sm" onClick={() => void runVerify()}>
                  Read every file
                </button>
              )}
            </div>
            <p className="dim small">
              Reads every byte on the folder and reports files that fail. An unreadable file is the earliest visible symptom of a
              failing card; copy everything off and retire it if any appear.
            </p>
            {verify && verifying && (
              <div className="progress">
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${verify.totalBytes ? Math.round((verify.bytes / verify.totalBytes) * 100) : 0}%` }} />
                </div>
                <div className="mono faint small ellipsis">
                  {verify.files}/{verify.totalFiles} files · {formatBytes(verify.bytes)} of {formatBytes(verify.totalBytes)} · {verify.current}
                </div>
              </div>
            )}
            {verifyResult && (
              <div className={`verdict ${verifyResult.errors.length ? "bad" : verifyResult.cancelled ? "unknown" : "good"}`}>
                <h3>{verifyResult.errors.length ? `${verifyResult.errors.length} unreadable files` : verifyResult.cancelled ? "Cancelled" : "All files readable"}</h3>
                <p className="dim small mono">
                  {formatBytes(verifyResult.bytes)} read in {(verifyResult.millis / 1000).toFixed(0)}s (
                  {(verifyResult.bytes / 1_048_576 / Math.max(0.001, verifyResult.millis / 1000)).toFixed(0)} MB/s)
                </p>
                {verifyResult.errors.length > 0 && (
                  <div className="err-list mono">
                    {verifyResult.errors.map(([p, e]) => (
                      <div key={p}>
                        {p}: {e}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          <hr className="rule" />
          <section>
            <h3>Recommendations</h3>
            <ul className="reco">
              {bus === "sd" || bus === "usb" ? (
                <>
                  <li>Flash wears out by writes, not reads. Culling and rating here only writes the small library file.</li>
                  <li>Keep a copy elsewhere before deleting from the card. Treat a card as a transport, not an archive.</li>
                  <li>Retire a card on the first unreadable file, on repeated camera write errors, or when read speed drops far below its rating.</li>
                  <li>Cards in heavy use typically give 3 to 5 years; swap them earlier for paid work. Format in the camera, not the computer.</li>
                  <li>Keep some free space. A full card forces the controller to rewrite the same blocks.</li>
                </>
              ) : (
                <>
                  <li>Run the readability check after copying a large shoot; errors show up on read long before the drive refuses to mount.</li>
                  <li>Replace the drive when SMART reports failures, reallocated sectors, or less than 10% life remaining.</li>
                  <li>Keep at least one more copy on different hardware.</li>
                </>
              )}
            </ul>
          </section>
        </>
      )}
    </Modal>
  );
}
