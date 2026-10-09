import Image from "next/image";
import logo from "@/assets/kubernetes-logo.png";

export function Logo({ size = 28 }: { size?: number }) {
  return <Image src={logo} alt="" width={size} height={size} priority />;
}
