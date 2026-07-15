import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

interface LobsterLoaderProps {
  size?: number;
  className?: string;
}

export function LobsterLoader({ size = 28, className }: LobsterLoaderProps) {
  const { t } = useTranslation();
  return (
    <span
      role="status"
      aria-label={t('common.loading', 'Loading')}
      className={cn("relative inline-block shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <img
        src="/lobster/body.png"
        alt=""
        aria-hidden
        className="lobster-body absolute inset-0 h-full w-full object-contain"
      />
      <img
        src="/lobster/left-claw.png"
        alt=""
        aria-hidden
        className="lobster-left-claw absolute inset-0 h-full w-full object-contain"
      />
      <img
        src="/lobster/right-claw.png"
        alt=""
        aria-hidden
        className="lobster-right-claw absolute inset-0 h-full w-full object-contain"
      />
    </span>
  );
}
