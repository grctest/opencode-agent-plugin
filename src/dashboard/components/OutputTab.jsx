import { memo, useState, useMemo } from "react";
import { renderMarkdown } from "./Cards.jsx";
import { Card, CardContent, CardFooter } from "./ui/card.tsx";
import { Button } from "./ui/button.tsx";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from "./ui/empty.tsx";
import { FileTextIcon, CopyIcon, CheckIcon, DownloadIcon } from "lucide-react";
import { toast } from "./ui/toast.tsx";

function OutputTabBase({ artifact, status }) {
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => renderMarkdown(artifact?.content ?? ""), [artifact?.content]);
  const download = (format) => {
    const meeting = new URLSearchParams(window.location.search).get("meeting");
    if (!meeting) return;
    const link = document.createElement("a");
    link.href = `/api/export?meeting=${encodeURIComponent(meeting)}&format=${format}`;
    link.download = "";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  const handleCopy = async (text) => {
    try {
      await navigator.clipboard.writeText(text ?? "");
      setCopied(true);
      try { toast.add({ title: "Copied to clipboard", type: "success" }); } catch {}
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  if (!artifact) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileTextIcon />
          </EmptyMedia>
          <EmptyTitle>{status && status !== "weaving" && status !== "initializing" ? "Synthesis in progress" : "No final artifact yet"}</EmptyTitle>
          <EmptyDescription>The final artifact appears here after synthesis finishes. You can keep reviewing the Timeline while it runs.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardContent className="pt-6">
          <div className="typeset typeset-docs max-w-none w-full">
            <div dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        </CardContent>
        <CardFooter className="flex items-center justify-between border-t bg-muted/20">
          <span className="text-xs text-muted-foreground">
            {artifact.created_at ? `Generated ${new Date(artifact.created_at).toLocaleString()}` : ""}
            {artifact.orchestrator_config ? ` · Orchestrator: ${[
              artifact.orchestrator_config.role,
              artifact.orchestrator_config.decisionPosture,
              artifact.orchestrator_config.synthesisStyle,
            ].filter(Boolean).join(" · ")}` : ""}
          </span>
           <div className="flex items-center gap-2">
             <Button variant="ghost" size="sm" onClick={() => download("markdown")}>
               <DownloadIcon className="size-3.5" /> Markdown
             </Button>
             <Button variant="ghost" size="sm" onClick={() => download("json")}>
               <DownloadIcon className="size-3.5" /> JSON
             </Button>
             <Button
               variant="outline"
               size="sm"
               onClick={() => handleCopy(artifact.content ?? "")}
             >
               {copied ? <><CheckIcon className="size-3.5" /> Copied</> : <><CopyIcon className="size-3.5" /> Copy</>}
             </Button>
           </div>
         </CardFooter>
      </Card>
    </div>
  );
}

const OutputTab = memo(OutputTabBase);
export { OutputTab };
