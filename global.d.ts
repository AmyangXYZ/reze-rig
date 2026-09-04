import "react"

declare module "react" {
  // T is unused here but must be declared, and named exactly as React names it,
  // for the interface to merge rather than shadow.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface InputHTMLAttributes<T> {
    /** Folder picker. Non-standard, so React does not declare it. */
    webkitdirectory?: string
  }
}
