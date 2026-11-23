import { Toaster as Sonner, type ToasterProps } from 'sonner'
import { useTheme } from '@/components/system/appearance'

// shadcn/ui's Toaster (Sonner), placed and themed per the system: bottom left, 5 seconds, paused
// on hover. Toasts render the system's Toast through toast.custom (see toast() in
// '@/components/system').
function Toaster(props: ToasterProps) {
  const { resolved } = useTheme()
  return <Sonner theme={resolved} position="bottom-left" duration={5000} gap={8} offset={16} toastOptions={{ unstyled: true }} {...props} />
}

export { Toaster }
