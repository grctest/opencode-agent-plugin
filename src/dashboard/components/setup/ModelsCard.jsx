import { List } from "react-window";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../ui/card.tsx";
import { Button } from "../ui/button.tsx";
import { Skeleton } from "../ui/skeleton.tsx";
import { ModelRow } from "./ModelRow.jsx";
import { MODEL_ROW_HEIGHT } from "./setupFormat.js";

export function ModelsCard({ llm, totalCount, enabledCount, busy, isFrozen, readOnly, refreshLlm, modelRowKey, toggleModel, sectionRef }) {
  const disabled = busy === "models" || isFrozen || readOnly;
  return (
    <Card ref={sectionRef}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <CardTitle>2. Models</CardTitle>
            <CardDescription>
              {totalCount === 0
                ? "Discovering available models…"
                : `${enabledCount} of ${totalCount} models enabled — each persona picks one in step 3.`}
            </CardDescription>
          </div>
          <div className="ml-auto">
            <Button variant="outline" size="sm" onClick={() => refreshLlm(true)} disabled={busy !== null || isFrozen || readOnly} title={isFrozen ? "Locked while a deliberation is running" : readOnly ? "Locked — this deliberation's configuration is read-only" : "Rescan providers (list is otherwise cached for 60s)"}>
              Refresh providers
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!llm ? (
          <div className="flex flex-col gap-2" aria-label="Loading models">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-3/4" />
          </div>
        ) : totalCount === 0 ? (
          <p className="text-sm text-muted-foreground">No models discovered. Connect a provider (e.g. `opencode auth login`), then hit Refresh providers.</p>
        ) : (
          <div
            className="h-64 rounded-lg border p-1.5"
            role="group"
            aria-label="Enable or disable models for Loom agents"
          >
            <List
              rowComponent={ModelRow}
              rowCount={(llm?.models ?? []).length}
              rowHeight={MODEL_ROW_HEIGHT}
              rowKey={modelRowKey}
              rowProps={{ items: llm?.models ?? [], disabled, onToggle: toggleModel }}
              overscanCount={4}
              style={{ height: "100%", width: "100%" }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
