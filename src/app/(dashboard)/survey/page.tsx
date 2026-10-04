"use client"

import { useMemo, useState } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useSurvey, useGatewayHealth, type SignalSample } from "@/hooks/use-router-data"
import { MapPin, Square, Play, Download, Trash2 } from "lucide-react"

// Samples in the first minutes after the gateway comes back up are noisy while
// it reattaches and picks a cell, so the comparison skips them by default.
const SETTLE_MS = 2 * 60 * 1000

interface LocationSummary {
  location: string
  samples: number
  sinrAvg: number
  sinrMin: number
  rsrpAvg: number
  rsrpMin: number
  rsrqAvg: number
  bands: string[]
  towers: string[]
  durationMs: number
}

const avg = (v: number[]) => Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10

// First recorded sample of each visit, so settling is measured from when the
// gateway was actually reachable rather than from when the label was set.
function visitStarts(entries: SignalSample[]): Map<number, number> {
  const starts = new Map<number, number>()
  for (const e of entries) {
    const v = e.visit ?? 0
    if (!starts.has(v)) starts.set(v, e.t)
  }
  return starts
}

function summarize(entries: SignalSample[], skipSettle: boolean): LocationSummary[] {
  const starts = visitStarts(entries)
  const byLoc = new Map<string, SignalSample[]>()
  for (const e of entries) {
    if (!e.loc) continue
    if (skipSettle && e.t - (starts.get(e.visit ?? 0) ?? e.t) < SETTLE_MS) continue
    const list = byLoc.get(e.loc) ?? []
    list.push(e)
    byLoc.set(e.loc, list)
  }

  const out: LocationSummary[] = []
  byLoc.forEach((list, location) => {
    const visits = new Map<number, { first: number; last: number }>()
    for (const e of list) {
      const v = visits.get(e.visit ?? 0)
      if (v) v.last = e.t
      else visits.set(e.visit ?? 0, { first: e.t, last: e.t })
    }
    let durationMs = 0
    visits.forEach((v) => (durationMs += v.last - v.first))

    out.push({
      location,
      samples: list.length,
      sinrAvg: avg(list.map((e) => e.sinr)),
      sinrMin: Math.min(...list.map((e) => e.sinr)),
      rsrpAvg: avg(list.map((e) => e.rsrp)),
      rsrpMin: Math.min(...list.map((e) => e.rsrp)),
      rsrqAvg: avg(list.map((e) => e.rsrq)),
      bands: Array.from(new Set(list.flatMap((e) => e.bands))),
      towers: Array.from(new Set(list.map((e) => `${e.gnbid}/${e.cid}`))),
      durationMs,
    })
  })

  return out.sort((a, b) => b.sinrAvg - a.sinrAvg)
}

function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function exportCsv(entries: SignalSample[]) {
  const header = "time,location,rsrp,rsrq,sinr,rssi,bands,gnbid,cid"
  const rows = entries.map((e) =>
    [
      new Date(e.t).toISOString(),
      JSON.stringify(e.loc ?? ""),
      e.rsrp,
      e.rsrq,
      e.sinr,
      e.rssi,
      e.bands.join(" "),
      e.gnbid,
      e.cid,
    ].join(",")
  )
  const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `placement-survey-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export default function SurveyPage() {
  const { data, mutate } = useSurvey()
  const { data: health } = useGatewayHealth()
  const [name, setName] = useState("")
  const [skipSettle, setSkipSettle] = useState(true)
  const [busy, setBusy] = useState(false)

  const entries = useMemo(() => data?.entries ?? [], [data])
  const active = data?.active ?? null
  const summaries = useMemo(() => summarize(entries, skipSettle), [entries, skipSettle])
  const knownLocations = useMemo(
    () => Array.from(new Set(entries.map((e) => e.loc).filter(Boolean))) as string[],
    [entries]
  )

  const visitSamples = active ? entries.filter((e) => e.visit === active.since) : []
  const latest = visitSamples[visitSamples.length - 1]
  const settleLeft = visitSamples.length
    ? SETTLE_MS - (Date.now() - visitSamples[0].t)
    : SETTLE_MS
  const online = health?.status === "online"

  const setLocation = async (location: string | null) => {
    setBusy(true)
    try {
      await fetch("/api/router/survey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location }),
      })
      setName("")
      await mutate()
    } finally {
      setBusy(false)
    }
  }

  const removeLocation = async (location: string) => {
    if (!window.confirm(`Delete all survey samples for "${location}"?`)) return
    await fetch(`/api/router/survey?location=${encodeURIComponent(location)}`, {
      method: "DELETE",
    })
    await mutate()
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <MapPin className="h-6 w-6 text-primary" />
          Placement Survey
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Name the spot, start recording, then move the gateway there. Samples are
          taken every 10 seconds and tagged with the location so spots can be
          compared side by side.
        </p>
      </div>

      {/* Current location */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Current location</CardTitle>
          <CardDescription className="text-xs">
            After moving, the gateway takes 2–3 minutes to reconnect. Leave it at
            least 5 minutes per spot for a fair reading.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {active ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div>
                <div className="text-2xl font-bold">{active.location}</div>
                <div className="text-xs text-muted-foreground">
                  Started{" "}
                  {new Date(active.since).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}{" "}
                  · {visitSamples.length} sample{visitSamples.length === 1 ? "" : "s"}
                </div>
              </div>
              <Badge variant={online ? "success" : "destructive"}>
                {online ? "Gateway online" : "Gateway offline"}
              </Badge>
              {online && visitSamples.length > 0 && (
                <Badge variant="outline">
                  {settleLeft > 0
                    ? `Settling, ${formatDuration(settleLeft)} left`
                    : "Settled"}
                </Badge>
              )}
              {latest && (
                <div className="flex gap-5 text-sm">
                  <span>
                    <span className="text-muted-foreground">SINR </span>
                    <span className="font-semibold">{latest.sinr} dB</span>
                  </span>
                  <span>
                    <span className="text-muted-foreground">RSRP </span>
                    <span className="font-semibold">{latest.rsrp} dBm</span>
                  </span>
                  <span>
                    <span className="text-muted-foreground">RSRQ </span>
                    <span className="font-semibold">{latest.rsrq} dB</span>
                  </span>
                  <span className="text-muted-foreground">
                    {latest.bands.join(", ")} · tower {latest.gnbid}/{latest.cid}
                  </span>
                </div>
              )}
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                disabled={busy}
                onClick={() => setLocation(null)}
              >
                <Square className="h-4 w-4 mr-2" />
                Stop recording
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Not recording a location. Samples are taken once a minute as usual.
            </p>
          )}

          <form
            className="flex gap-2 max-w-md"
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim()) setLocation(name.trim())
            }}
          >
            <Input
              placeholder={active ? "Next spot, e.g. Upstairs window" : "Spot name, e.g. Office shelf"}
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" disabled={busy || !name.trim()}>
              <Play className="h-4 w-4 mr-2" />
              Start recording here
            </Button>
          </form>

          {knownLocations.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Return to:</span>
              {knownLocations.map((loc) => (
                <Button
                  key={loc}
                  variant="secondary"
                  size="sm"
                  disabled={busy || active?.location === loc}
                  onClick={() => setLocation(loc)}
                >
                  {loc}
                </Button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Comparison */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Locations compared</CardTitle>
              <CardDescription className="text-xs">
                Sorted by average SINR, which predicts speed best. RSRP above −90
                dBm and SINR above 20 dB are strong.
              </CardDescription>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={skipSettle}
                  onChange={(e) => setSkipSettle(e.target.checked)}
                />
                Skip first 2 min of each visit
              </label>
              <Button
                variant="outline"
                size="sm"
                disabled={entries.length === 0}
                onClick={() => exportCsv(entries)}
              >
                <Download className="h-4 w-4 mr-2" />
                Export CSV
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {summaries.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {entries.length === 0
                ? "No survey samples yet. Start recording a location above."
                : "No settled samples yet. The first 2 minutes of each visit are skipped."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">SINR avg</TableHead>
                  <TableHead className="text-right">SINR min</TableHead>
                  <TableHead className="text-right">RSRP avg</TableHead>
                  <TableHead className="text-right">RSRP min</TableHead>
                  <TableHead className="text-right">RSRQ avg</TableHead>
                  <TableHead>Band</TableHead>
                  <TableHead>Tower</TableHead>
                  <TableHead className="text-right">Samples</TableHead>
                  <TableHead className="text-right">Time</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {summaries.map((s, i) => (
                  <TableRow key={s.location}>
                    <TableCell className="font-medium">
                      {s.location}
                      {i === 0 && summaries.length > 1 && (
                        <Badge className="ml-2" variant="secondary">
                          Best
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-semibold">{s.sinrAvg}</TableCell>
                    <TableCell className="text-right">{s.sinrMin}</TableCell>
                    <TableCell className="text-right">{s.rsrpAvg}</TableCell>
                    <TableCell className="text-right">{s.rsrpMin}</TableCell>
                    <TableCell className="text-right">{s.rsrqAvg}</TableCell>
                    <TableCell>{s.bands.join(", ")}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {s.towers.join(", ")}
                    </TableCell>
                    <TableCell className="text-right">{s.samples}</TableCell>
                    <TableCell className="text-right">{formatDuration(s.durationMs)}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={`Delete ${s.location}`}
                        onClick={() => removeLocation(s.location)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
