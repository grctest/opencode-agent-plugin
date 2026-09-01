import { memo, useState, useCallback, useEffect, useMemo, useRef } from "react";
import { renderMarkdown } from "./Cards.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";
import { Badge } from "./ui/badge.tsx";
import { Input } from "./ui/input.tsx";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from "./ui/empty.tsx";
import { MessageSquareIcon, SearchIcon, MessagesSquareIcon, XIcon, AlertCircleIcon } from "lucide-react";
import { relativeTime, cn } from "../utils.js";

function TopicListItem({ topic, isSelected, onClick, participantName }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      onClick={onClick}
      className={cn(
        "w-full text-left p-3 rounded-lg border transition-colors cursor-pointer",
        "hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isSelected
          ? "bg-primary/10 border-primary/40 ring-1 ring-primary/20"
          : "border-transparent"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium line-clamp-1 flex-1">{topic.title}</h3>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {topic.comment_count} {topic.comment_count === 1 ? "reply" : "replies"}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-1.5">
        <span className="text-xs text-muted-foreground">
          {participantName(topic.author_id)}
        </span>
        <span className="text-xs text-muted-foreground">·</span>
        <span className="text-xs text-muted-foreground">
          {relativeTime(topic.created_at)}
        </span>
      </div>
      {topic.tags?.length > 0 && (
        <div className="flex gap-1 mt-2 flex-wrap">
          {topic.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0">
              {tag}
            </Badge>
          ))}
        </div>
      )}
    </button>
  );
}

function TopicDetail({ topic, participantName }) {
  const bodyHtml = useMemo(() => renderMarkdown(topic.body ?? ""), [topic.body]);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">{topic.title}</CardTitle>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{participantName(topic.author_id)}</span>
            <span>·</span>
            <span>{relativeTime(topic.created_at)}</span>
            {topic.tags?.length > 0 && (
              <>
                <span>·</span>
                <div className="flex gap-1">
                  {topic.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="typeset typeset-docs max-w-none">
            <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />
          </div>
        </CardContent>
      </Card>

      {topic.comments?.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">
            {topic.comments.length} {topic.comments.length === 1 ? "Comment" : "Comments"}
          </h3>
          {topic.comments.map((comment) => (
            <Card key={comment.id}>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                  <span className="font-medium text-foreground">
                    {participantName(comment.author_id)}
                  </span>
                  <span>·</span>
                  <span>{relativeTime(comment.created_at)}</span>
                </div>
                <div className="typeset typeset-docs max-w-none text-sm">
                  <div dangerouslySetInnerHTML={{ __html: renderMarkdown(comment.body ?? "") }} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-1">
      <div className="h-6 w-2/3 bg-muted animate-pulse rounded" />
      <div className="h-4 w-1/3 bg-muted animate-pulse rounded" />
      <div className="space-y-3 mt-4">
        <div className="h-4 w-full bg-muted animate-pulse rounded" />
        <div className="h-4 w-5/6 bg-muted animate-pulse rounded" />
        <div className="h-4 w-4/6 bg-muted animate-pulse rounded" />
      </div>
    </div>
  );
}

function ForumTabBase({ forumTopics, participantName, selectedMeeting }) {
  const [selectedTopicId, setSelectedTopicId] = useState(null);
  const [filter, setFilter] = useState("");
  const [topicDetail, setTopicDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [errorDetail, setErrorDetail] = useState(null);
  const listRef = useRef(null);

  const filteredTopics = useMemo(() => {
    if (!filter.trim()) return forumTopics;
    const q = filter.toLowerCase();
    return forumTopics.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.tags?.some((tag) => tag.toLowerCase().includes(q))
    );
  }, [forumTopics, filter]);

  const handleSelectTopic = useCallback(async (topicId) => {
    setSelectedTopicId(topicId);
    setLoadingDetail(true);
    setErrorDetail(null);
    try {
      // selectedMeeting is already the meeting ID string
      const meetingId = selectedMeeting;
      if (!meetingId) {
        setErrorDetail("No meeting selected");
        setLoadingDetail(false);
        return;
      }
      const res = await fetch(`/api/forum/topic?meeting=${encodeURIComponent(meetingId)}&topic_id=${topicId}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error(errData?.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setTopicDetail(data);
    } catch (e) {
      setErrorDetail(e.message || "Failed to load topic");
      setTopicDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  }, [selectedMeeting]);

  const handleRetry = useCallback(() => {
    if (selectedTopicId) handleSelectTopic(selectedTopicId);
  }, [selectedTopicId, handleSelectTopic]);

  const handleKeyDown = useCallback((e) => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('[role="option"]');
    const currentIndex = Array.from(items).findIndex((el) => el === document.activeElement);
    let nextIndex = -1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      nextIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (currentIndex >= 0) items[currentIndex].click();
      return;
    }
    if (nextIndex >= 0 && items[nextIndex]) {
      items[nextIndex].focus();
    }
  }, []);

  // Reset selection when meeting changes
  useEffect(() => {
    setSelectedTopicId(null);
    setTopicDetail(null);
    setErrorDetail(null);
    setFilter("");
  }, [selectedMeeting]);

  if (!forumTopics || forumTopics.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessagesSquareIcon />
          </EmptyMedia>
          <EmptyTitle>No forum topics yet</EmptyTitle>
          <EmptyDescription>
            Agents create topics with <code>loom_forum_create_topic</code> to start sub-discussions.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex gap-4 h-[calc(100dvh-10rem)]">
      {/* Topic list panel */}
      <div className="w-80 flex-shrink-0 flex flex-col border rounded-lg overflow-hidden">
        <div className="p-3 border-b">
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              placeholder="Filter topics..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && filter) {
                  setFilter("");
                  e.currentTarget.blur();
                }
              }}
              className="pl-8 pr-8 h-8 text-sm"
            />
            {filter && (
              <button
                type="button"
                onClick={() => setFilter("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 size-4 text-muted-foreground hover:text-foreground cursor-pointer"
                aria-label="Clear filter"
              >
                <XIcon className="size-4" />
              </button>
            )}
          </div>
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-label="Forum topics"
          onKeyDown={handleKeyDown}
          className="flex-1 overflow-y-auto p-2 flex flex-col gap-1"
        >
          {filteredTopics.map((topic) => (
            <TopicListItem
              key={topic.id}
              topic={topic}
              isSelected={selectedTopicId === topic.id}
              onClick={() => handleSelectTopic(topic.id)}
              participantName={participantName}
            />
          ))}
          {filteredTopics.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No topics match your filter
            </p>
          )}
        </div>
      </div>

      {/* Topic detail panel */}
      <div className="flex-1 overflow-y-auto">
        {loadingDetail ? (
          <LoadingSkeleton />
        ) : errorDetail ? (
          <Empty className="border h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AlertCircleIcon />
              </EmptyMedia>
              <EmptyTitle>Failed to load topic</EmptyTitle>
              <EmptyDescription>{errorDetail}</EmptyDescription>
            </EmptyHeader>
            <button
              type="button"
              onClick={handleRetry}
              className="mt-2 px-4 py-2 text-sm font-medium text-primary hover:underline cursor-pointer"
            >
              Retry
            </button>
          </Empty>
        ) : topicDetail ? (
          <TopicDetail topic={topicDetail} participantName={participantName} />
        ) : (
          <Empty className="border h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessageSquareIcon />
              </EmptyMedia>
              <EmptyTitle>Select a topic</EmptyTitle>
              <EmptyDescription>
                Choose a topic from the list to view its discussion
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
}

const ForumTab = memo(ForumTabBase);
export { ForumTab };
