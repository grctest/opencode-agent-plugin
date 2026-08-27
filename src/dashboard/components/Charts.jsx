import { useMemo, memo } from "react";
import { cn } from "../utils.js";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card.tsx";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./ui/table.tsx";
import { Badge } from "./ui/badge.tsx";
import { ScrollArea, ScrollBar } from "./ui/scroll-area.tsx";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "./ui/chart.tsx";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, LineChart, Line } from "recharts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

export const ParticipationMatrix = memo(function ParticipationMatrix({ participants, contributions, agentErrors, orchestratorMessages, rounds, activeRound }) {
  const roundData = useMemo(() => {
    const contribMap = new Map();
    for (const c of contributions) contribMap.set(`${c.participant_id}:${c.round}`, true);
    const errorMap = new Map();
    const errorRounds = new Set();
    for (const e of agentErrors) {
      if (!errorMap.has(`${e.participant_id}:${e.round}`)) errorMap.set(`${e.participant_id}:${e.round}`, true);
      errorRounds.add(e.round);
    }
    const reflectionMap = new Map();
    for (const c of contributions) {
      if (c.type === "reflection") {
        const key = `${c.participant_id}:${c.round}`;
        reflectionMap.set(key, (reflectionMap.get(key) || 0) + 1);
      }
    }
    const orderMap = new Map();
    for (let r = 1; r <= rounds; r++) {
      const roundContribs = contributions
        .filter((c) => c.round === r && !["reflection", "query_response", "perspective_response", "critique_response", "evidence_response", "summoned_response", "vote_response", "vote_tally"].includes(c.type))
        .slice()
        .sort((a, b) => (a.created_at || "").localeCompare(b.created_at || "") || ((a.id ?? 0) - (b.id ?? 0)));
      roundContribs.forEach((c, i) => orderMap.set(`${c.participant_id}:${r}`, i + 1));
    }
    const speakingParticipants = new Set();
    for (const p of participants) if (p.status === "speaking") speakingParticipants.add(p.id);
    const data = [];
    for (let r = 1; r <= rounds; r++) {
      const row = {};
      for (const p of participants) {
        const key = `${p.id}:${r}`;
        const reflectionCount = reflectionMap.get(key) || 0;
        const isSpeaking = r === activeRound && speakingParticipants.has(p.id) && !contribMap.has(key);
        if (contribMap.has(key)) row[p.id] = { status: "contributed", order: orderMap.get(key) || null, reflectionCount };
        else if (errorMap.has(key)) row[p.id] = { status: "error", order: null, reflectionCount };
        else if (p.status === "passed") row[p.id] = { status: "passed", order: null, reflectionCount };
        else if (activeRound && r > activeRound) row[p.id] = { status: "future", order: null, reflectionCount };
        else row[p.id] = { status: isSpeaking ? "speaking" : "none", order: null, reflectionCount };
      }
      data.push({ round: r, participants: row });
    }
    return { data, errorRounds };
  }, [participants, contributions, agentErrors, rounds, activeRound]);

  const orchestratorData = useMemo(() => {
    const msgs = orchestratorMessages ?? [];
    const roundTasks = new Map();
    for (const msg of msgs) {
      if (!msg.round) continue;
      if (!roundTasks.has(msg.round)) roundTasks.set(msg.round, new Map());
      const tasks = roundTasks.get(msg.round);
      if (msg.role === "user" && msg.type) {
        if (!tasks.has(msg.type)) tasks.set(msg.type, { requested: true, completed: false });
      } else if (msg.role === "assistant" && msg.type) {
        const task = tasks.get(msg.type);
        if (task) task.completed = true;
        else tasks.set(msg.type, { requested: true, completed: true });
      }
    }
    return roundTasks;
  }, [orchestratorMessages]);

  if (rounds === 0 || participants.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Participation</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <ScrollArea>
          <div className="px-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">Round</TableHead>
                  {participants.map((p) => (
                    <TableHead key={p.id} className="text-center min-w-[4rem]">
                      <div className="flex flex-col items-center">
                        <span className="font-medium text-xs truncate">{p.name}</span>
                        <span className="text-[10px] text-muted-foreground uppercase">{p.tier}</span>
                      </div>
                    </TableHead>
                  ))}
                  <TableHead className="text-center w-16">Orch.</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {roundData.data.map(({ round, participants: row }) => {
                  const tasks = orchestratorData.get(round) || new Map();
                  const taskTypes = ["moderation", "turn_order", "summary", "synthesis"];
                  return (
                    <TableRow key={round} className={cn(roundData.errorRounds.has(round) && "bg-destructive/5")}>
                      <TableCell className="font-medium text-muted-foreground">R{round}</TableCell>
                      {participants.map((p) => {
                        const cell = row[p.id];
                        const status = cell?.status ?? "none";
                        const reflectionCount = cell?.reflectionCount ?? 0;
                        if (status === "speaking") {
                          return (
                            <TableCell key={p.id} className="text-center">
                              <span className="inline-flex animate-spin text-xs" aria-label="processing">⚙</span>
                              {reflectionCount > 0 && <Badge variant="reflection" className="ml-1 text-[10px] px-1 py-0 h-4">{reflectionCount}↩</Badge>}
                            </TableCell>
                          );
                        }
                        if (status === "contributed" && cell.order) {
                          return (
                            <TableCell key={p.id} className="text-center">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex items-center justify-center min-w-6 h-5 rounded-full bg-emerald-600 text-white text-xs font-bold px-1.5">{cell.order}</span>
                                </TooltipTrigger>
                                <TooltipContent>Spoke {cell.order} in round {round}</TooltipContent>
                              </Tooltip>
                              {reflectionCount > 0 && <Badge variant="reflection" className="ml-1 text-[10px] px-1 py-0 h-4">{reflectionCount}↩</Badge>}
                            </TableCell>
                          );
                        }
                        return (
                          <TableCell key={p.id} className="text-center">
                            <span className={cn(
                              "inline-block size-3 rounded-full",
                              status === "error" && "bg-destructive",
                              status === "passed" && "bg-muted-foreground/40",
                              status === "none" && "bg-amber-500",
                              status === "future" && "bg-transparent border border-border"
                            )} title={status} />
                            {reflectionCount > 0 && <Badge variant="reflection" className="ml-1 text-[10px] px-1 py-0 h-4">{reflectionCount}↩</Badge>}
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-center">
                        <div className="flex gap-1 justify-center">
                          {taskTypes.map((type) => {
                            const task = tasks.get(type);
                            if (!task) return null;
                            if (task.completed) return <span key={type} className="inline-block size-3 rounded-full bg-emerald-600" title={`${type}: completed`} />;
                            return <span key={type} className="inline-flex animate-spin text-xs" title={`${type}: processing`}>⚙</span>;
                          })}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
        <div className="flex flex-wrap gap-3 mt-3 px-6 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="inline-flex items-center justify-center min-w-5 h-4 rounded-full bg-emerald-600 text-white text-xs font-bold px-1">1</span> Contributed</span>
          <span className="flex items-center gap-1"><span className="inline-flex animate-spin text-xs">⚙</span> Processing</span>
          <span className="flex items-center gap-1"><span className="inline-block size-3 rounded-full bg-destructive" /> Error</span>
          <span className="flex items-center gap-1"><span className="inline-block size-3 rounded-full bg-muted-foreground/40" /> Passed</span>
          <span className="flex items-center gap-1"><span className="inline-block size-3 rounded-full bg-amber-500" /> Pending</span>
        </div>
      </CardContent>
    </Card>
  );
});

export const ContributionTypeChart = memo(function ContributionTypeChart({ contributions }) {
  const data = useMemo(() => {
    const typeCounts = {};
    for (const c of contributions) typeCounts[c.type] = (typeCounts[c.type] || 0) + 1;
    const total = contributions.length;
    return Object.entries(typeCounts)
      .map(([type, count]) => ({ type, count, fill: "var(--color-primary)" }))
      .sort((a, b) => b.count - a.count);
  }, [contributions]);

  if (data.length === 0) return null;

  const config = {};
  data.forEach((d, i) => { config[d.type] = { label: d.type, color: `var(--chart-${(i % 5) + 1})` }; });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Contribution Types</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="h-[140px] w-full">
          <BarChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="type" tickLine={false} axisLine={false} tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={36} />
            <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 10 }} allowDecimals={false} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey="count" radius={[4, 4, 0, 0]} fill="var(--color-primary)" />
          </BarChart>
        </ChartContainer>
        <div className="flex flex-wrap gap-2 mt-2">
          {data.map((d) => (
            <span key={d.type} className="text-xs text-muted-foreground">{d.type}: {d.count} ({Math.round((d.count / contributions.length) * 100)}%)</span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
});

export const ContributionTimeline = memo(function ContributionTimeline({ contributions }) {
  const data = useMemo(() => {
    const roundCounts = {};
    for (const c of contributions) roundCounts[c.round] = (roundCounts[c.round] || 0) + 1;
    const rounds = Object.keys(roundCounts).map(Number).sort((a, b) => a - b);
    if (rounds.length < 2) return [];
    return rounds.map((r) => ({ round: `R${r}`, count: roundCounts[r] }));
  }, [contributions]);

  if (data.length < 2) return null;

  const config = { count: { label: "Contributions", color: "var(--chart-1)" } };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Activity Over Time</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="h-[120px] w-full">
          <LineChart data={data} margin={{ top: 4, right: 12, left: -20, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="round" tickLine={false} axisLine={false} tick={{ fontSize: 10 }} />
            <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 10 }} allowDecimals={false} />
            <ChartTooltip content={<ChartTooltipContent labelKey="round" />} />
            <Line type="monotone" dataKey="count" stroke="var(--color-primary)" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ChartContainer>
        <div className="flex justify-between text-[11px] text-muted-foreground mt-1">
          <span>{data[0].round}</span>
          <span>{data[data.length - 1].round}</span>
        </div>
      </CardContent>
    </Card>
  );
});
