# Apple Health

Steps, heart rate, sleep, workouts, HRV, VO2 max, menstrual cycle, mindful minutes — everything on your iPhone and Apple Watch lives here.

## What you can export

- Every health metric Apple records (all types, all time ranges)
- Workout sessions + GPS routes (as GPX)
- ECG recordings (as CSV)
- Sleep stages (Watch-logged)
- Clinical records if connected

Format: one big `export.xml` (or `export_cda.xml`) + a `workout-routes/` folder of GPX files, all zipped.

## Option 1 — Health app export (recommended)

The only supported path. Mobile-only — no desktop or web equivalent.

1. On iPhone: open **Health** → tap your profile picture (top right).
2. Scroll to the bottom → **Export All Health Data**.
3. Wait (1–10 min depending on history — the XML can be 100MB+ for years of Watch data).
4. Share sheet opens — AirDrop to Mac, or save to Files → iCloud → pull from Mac.
5. Drop the `export.zip` into this data page.

[Start with agent →](mld:Help me import my Apple Health export.zip. Unpack it under imports/apple-health/ and run the apple-health skill's discovery script to see what record types are present and how many years of data.)

## Option 2 — Convert to MyLifeDB JSON for the apple-health skill

The `apple-health` skill expects data in a per-record-type JSON format for its analysis scripts. Conversion is a separate step after the raw XML lands.

[Start with agent →](mld:I have an Apple Health export unpacked at imports/apple-health/. Convert export.xml into the MyLifeDB JSON format the apple-health skill expects, so its analysis scripts can run.)

## Option 3 — Continuous sync via the Auto Export app

For incremental updates without re-exporting manually each time. Third-party app (`Health Auto Export`) pushes metrics to iCloud Drive or a webhook on a schedule.

[Start with agent →](mld:Help me set up Health Auto Export to push daily Apple Health data to a folder I can sync into imports/apple-health/. Walk me through the app's setup.)

## Where it lands

`imports/apple-health/` — raw XML + GPX routes, plus any converted JSON from the skill.

## Related

See the `apple-health` skill for analysis (sleep, heart rate, trends, dashboards).
