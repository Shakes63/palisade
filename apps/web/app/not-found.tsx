import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function NotFound() {
  return (
    <div className="card mx-auto mt-12 max-w-md space-y-3 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-slate-400">There is nothing at this address.</p>
      <Link href="/" className="btn-secondary inline-flex">
        <ArrowLeft className="h-4 w-4" /> Back to servers
      </Link>
    </div>
  );
}
