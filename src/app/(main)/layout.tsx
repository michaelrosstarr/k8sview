import { ModalsProvider } from "@mantine/modals";
import { LogDockProvider } from "@/components/logs/LogDock";
import { PortForwardsProvider } from "@/components/PortForwards";

// Providers for the main window only; popped-out log windows don't need them.
// PortForwardsProvider sits above ModalsProvider so dialogs can start forwards.
export default function MainLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <PortForwardsProvider>
      <LogDockProvider>
        <ModalsProvider>{children}</ModalsProvider>
      </LogDockProvider>
    </PortForwardsProvider>
  );
}
