import { memo, useState } from "react";
import { renderMarkdown } from "./Cards.jsx";
import { Card, CardContent, CardFooter } from "./ui/card.tsx";
import { Button } from "./ui/button.tsx";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from "./ui/empty.tsx";
import { FileTextIcon, CopyIcon, CheckIcon } from "lucide-react";
import { toast } from "./ui/toast.tsx";

function OutputTabBase({ artifact }) {
  const [copied, setCopied] = useState(false);
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
          <EmptyTitle>No final artifact yet</EmptyTitle>
          <EmptyDescription>It appears here once the deliberation completes and synthesis finishes.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const html = renderMarkdown(artifact.content ?? "");

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
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleCopy(artifact.content ?? "")}
          >
            {copied ? <><CheckIcon className="size-3.5" /> Copied</> : <><CopyIcon className="size-3.5" /> Copy</>}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

const OutputTab = memo(OutputTabBase);
export { OutputTab };
