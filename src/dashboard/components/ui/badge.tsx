import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
        // Tier variants (loom semantics)
        junior: "bg-secondary text-secondary-foreground",
        mid: "bg-[var(--badge-blue-mid)] text-white",
        senior: "bg-[var(--badge-purple-dark)] text-white",
        principal: "bg-[var(--badge-yellow)] text-white",
        // Type variants
        propose: "bg-[var(--badge-green-dark)] text-white",
        challenge: "bg-[var(--badge-red)] text-white",
        refine: "bg-[var(--badge-blue-deep)] text-white",
        support: "bg-[var(--badge-teal-dark)] text-white",
        dissent: "bg-[var(--badge-brown)] text-white",
        synthesize: "bg-[var(--badge-purple)] text-white",
        question: "bg-[var(--badge-cyan)] text-white",
        reflection: "bg-[var(--badge-indigo)] text-white",
        query_response: "bg-[var(--badge-teal)] text-white",
        evidence_response: "bg-[var(--badge-sky)] text-white",
        summoned_response: "bg-[var(--badge-violet)] text-white",
        vote_response: "bg-[var(--badge-emerald)] text-white",
        turn_request: "bg-[var(--badge-pink)] text-white",
        // Status variants
        weaving: "bg-[var(--badge-amber)] text-white",
        converged: "bg-[var(--badge-green)] text-white",
        max_rounds_reached: "bg-[var(--badge-orange)] text-white",
        initializing: "bg-muted text-muted-foreground",
        aborted: "bg-[var(--badge-gray)] text-white",
        timeout: "bg-[var(--badge-red)] text-white",
        orchestrator: "bg-[var(--badge-gray)] text-white",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
