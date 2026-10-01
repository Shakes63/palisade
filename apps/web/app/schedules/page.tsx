"use client";
import { CalendarClock } from "lucide-react";
import { ScheduleList } from "@/components/schedule-list";
import { useMe } from "@/lib/use-me";

export default function SchedulesPage() {
  const me = useMe();
  return (
    <div className="space-y-6">
      <h1 className="flex items-center gap-2 text-xl font-semibold">
        <CalendarClock className="h-5 w-5 text-ark-accent" /> Global schedules
      </h1>
      {me?.restricted ? (
        <div className="card text-sm text-slate-400">
          Global schedules reach every server, so they need an account that isn&apos;t limited to some servers.
        </div>
      ) : (
        <>
          <p className="text-sm text-slate-400">
            One schedule that runs on many servers at once. Each server&apos;s Schedules tab lists the global
            schedules that reach it. To give one server its own copy instead, use the copy button on a schedule
            there.
          </p>
          <ScheduleList />
        </>
      )}
    </div>
  );
}
