import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { About } from '@app/renderer/About'
import logo from '../../../assets/ZoneTester.webp'
import { DnsLookup } from './DnsLookup'
import { SubdomainFinder } from './SubdomainFinder'
import { TlsTester } from './TlsTester'
import { EmailTester } from './EmailTester'

type View = 'dns' | 'subdomains' | 'tls' | 'email' | 'about'
const VIEWS: ReadonlyArray<readonly [View, string]> = [['dns', 'DNS lookup'], ['subdomains', 'Subdomain finder'], ['tls', 'TLS tester'], ['email', 'Email security'], ['about', 'About']]

export function App(): JSX.Element {
  const [active, setActive] = useState<View>('dns')
  return (
    <div className="app">
      <header className="header">
        <img src={logo} alt="ZoneTester" className="logo" />
        <div className="header-actions">
          <button onClick={() => void window.zonekit.openTool('zonekeeper')}>Open ZoneKeeper</button>
        </div>
      </header>
      <nav className="sidebar" aria-label="Tools">
        {VIEWS.map(([id, label]) => (
          <button
            key={id}
            className={`${id === active ? 'active' : ''}${id === 'about' ? ' pin-bottom' : ''}`}
            aria-current={id === active ? 'page' : undefined}
            onClick={() => setActive(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <main className="content">
        {active === 'dns' && <DnsLookup />}
        {active === 'subdomains' && <SubdomainFinder />}
        {active === 'tls' && <TlsTester />}
        {active === 'email' && <EmailTester />}
        {active === 'about' && (
          <About logo={logo} name="ZoneTester" description="See how any domain looks to the outside world. ZoneTester uses public DNS and connections only, so it needs no account or API token.">
            <h3>DNS lookup</h3>
            <p>Look up any record type through the resolver you choose, and click a result to see what it means.</p>
            <h3>Subdomain finder</h3>
            <p>Finds subdomains from common names, DNS records, certificates and variations of names already found.</p>
            <h3>TLS tester</h3>
            <p>Checks protocols, ciphers and the certificate, with an optional full scan by testssl.sh.</p>
            <h3>Email security</h3>
            <p>Checks MX, SPF, DMARC, DKIM, MTA-STS, TLS reporting and BIMI.</p>
          </About>
        )}
      </main>
    </div>
  )
}
