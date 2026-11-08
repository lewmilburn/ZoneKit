import type { ComponentChildren, JSX } from 'preact'
import { SUITE_NAME, SUITE_VERSION } from '../shared/tools'

/** Every tool's About page. */
export function About(props: { logo: string; name: string; description: ComponentChildren; children?: ComponentChildren }): JSX.Element {
  return (
    <div>
      <img src={props.logo} alt={props.name} className="about-logo" />
      <p>{props.description}</p>
      {props.children}
      <h3>Version information</h3>
      <p>Created by Lewis Milburn</p>
      <p className="muted">{SUITE_NAME} version {SUITE_VERSION}</p>
      <p className="muted">Licensed under Apache-2.0.</p>
      <p className="muted">ZoneKit is not affiliated with or endorsed by Cloudflare. Cloudflare is a trademark of Cloudflare, Inc.</p>
    </div>
  )
}
