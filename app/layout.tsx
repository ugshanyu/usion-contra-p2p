import type { Metadata } from 'next';
import Script from 'next/script';

export const metadata: Metadata = {
    title: 'Contra P2P',
    description: 'Co-op side-scrolling shooter — P2P WebRTC reference',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" style={{ height: '100%' }}>
            <head>
                <Script src="/usion-sdk.js" strategy="beforeInteractive" />
                <link rel="stylesheet" href="/usion-design-system.css" />
            </head>
            <body style={{ margin: 0, height: '100dvh', overflow: 'hidden', background: '#000', color: '#fff' }}>
                {children}
            </body>
        </html>
    );
}
