# Long jobs show in Activity

Anything that can take more than a moment shows in **Activity**: the progress ring at the top
of every screen, its drop-down, and the full Activity page. One place to see everything that is
running, with what each job is on, how far it has got, and a way to stop it. No job gets its own
floating pill or corner widget.

## What counts

A job belongs in Activity when it can run for more than a second or two, or for a length you
can't know in advance. For example:

- Scans and matching (duplicates, album folders).
- Indexing for tags.
- Encrypting, decrypting or exporting vault files.
- Backups.
- Downloads (models).
- Edits, video edits especially.
- Bulk changes (trashing many duplicates, cleaning a copied folder).
- Detection runs (album languages).
- Plugins' jobs (`ui.progress`), and their pipelines' progress in the local engine.

A job may still show progress on its own screen as well (the Duplicates screen has its scan
panel). Activity is in addition, never instead.

## Every job reports progress and can be paused and stopped

This is enforced by type. `startJob` in `src/lib/jobs.ts` won't compile without these:

- **`total`**: what `done` counts up to.
- **`pause`**: pauses and resumes the job.
- **`stop`**: ends it, and what is done stays done.

A job leaves one out only by saying why: `total: { unknown: "…" }`, or `pause: { cannot: "…" }`. Activity shows the reason on the greyed-out button. Keep these for true single steps that can't be split. Moving the model folder is one: stopping halfway would leave the models in two places.

Pause holds a job **between steps**: the file, page or group under way finishes, then it waits. For a job that runs a child process (ffmpeg, the engine's download), Pause suspends the process where it is and Resume continues it. Stop ends the job at its next step, or kills the process.

## How

**A job done step by step in the app**, with `steppedJob`:

```ts
const { job, gate } = steppedJob({ title: "Reading album languages", source: "Albums", total: albums.length });
try {
  for (const [n, a] of albums.entries()) {
    if (!(await gate.pass())) break; // waits while paused; false once stopped
    job.update({ done: n, detail: a.name, items: [{ key: a.cover.key }] });
    // …one step…
  }
} finally {
  job.finish();
}
```

**A job one backend command runs**, with `backendJob`. The command takes `job: Option<String>` and calls `control(job)` (in `src-tauri/src/lib.rs`). Between steps it asks `ctl.go_on()`, which waits while paused and returns false once stopped. A child process is handed to `jobctl::watch_child`. Start the job in the command's `src/lib/api.ts` wrapper (see `vaultCommand`, `backupRun`, `engineDownload`), so every caller gets Activity without doing anything.

- **`title`** says what it does ("Backing up"). **`source`** says where it was started from ("Backup").
- **`bytes: true`** shows done and total as sizes. **`percent: true`** shows them as a percentage.
- **`detail`** is a short line on what it is doing now.
- **`items`** are the item keys it is on, shown as thumbnails.
- **Update as often as you like.** Updates are drawn a few times a second, and the end shows at once.

**Plugins** call `ms.ui.progress(id, { label, done, total, detail, item, pausable })`. Activity's Stop sends them `cancel`. With `pausable: true`, Pause and Resume send `pause` ({ id, paused }). See `docs/plugins.md`.

Built-in jobs with their own stores (the duplicate scan, tag indexing) are read by `buildJobs` in `src/lib/activity.ts`, which holds them to the same `Job` type. A new job uses `steppedJob` or `backendJob`, not a new store.
