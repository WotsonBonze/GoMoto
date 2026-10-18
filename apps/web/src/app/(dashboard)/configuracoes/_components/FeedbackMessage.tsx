import { AlertCircle, CheckCircle2 } from 'lucide-react'

export interface FeedbackState {
  type: 'success' | 'error'
  message: string
}

/** Mensagem inline de sucesso ou erro exibida após uma operação assíncrona. */
export function FeedbackMessage({ feedback }: { feedback: FeedbackState | null }) {
  if (!feedback) return null
  const isSuccess = feedback.type === 'success'
  return (
    <div
      className={`flex items-center gap-2 rounded-2xl px-4 py-3 text-[13px] font-medium ${
        isSuccess
          ? 'bg-success-bg border border-success text-success'
          : 'bg-danger-bg border border-danger text-danger'
      }`}
    >
      {isSuccess ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
      <span>{feedback.message}</span>
    </div>
  )
}
