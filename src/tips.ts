// tips.md converted to HTML once (see the Tips page: renderTipsMain in render.ts).
// Pure content, no build-time markdown parsing. Regenerate by hand if tips.md changes.

/** The inner-<main> body of the Tips page (headings carry GitHub-style anchor ids). */
export const TIPS_HTML = `
<h2 id="tips">Tips</h2>
<blockquote>
	<h4 id="table-of-contents">Table of Contents</h4>
	<ul>
		<li><a href="#cam-hunting">Cam hunting</a>
		<ul>
			<li><a href="#google-dorks">Google dorks</a></li>
			<li><a href="#shodan-safari">Shodan safari</a></li>
		</ul>
		</li>
		<li><a href="#tips-for-viewing-web-cams">Tips for viewing web cams</a>
		<ul>
			<li><a href="#how-to-use-this-section">How to use this section</a></li>
			<li><a href="#generic-patterns">Generic patterns</a></li>
			<li><a href="#check-the-codec">Check the codec</a></li>
			<li><a href="#by-vendor">By vendor</a>
			<ul>
				<li><a href="#axis">Axis</a></li>
				<li><a href="#cp-plus">CP Plus</a></li>
				<li><a href="#dahua-and-amcrest">Dahua and Amcrest</a></li>
				<li><a href="#d-link">D-Link</a></li>
				<li><a href="#foscam">Foscam</a></li>
				<li><a href="#hikvision">Hikvision</a></li>
				<li><a href="#instar">INSTAR</a></li>
				<li><a href="#lilin">LILIN</a></li>
				<li><a href="#sony">Sony</a></li>
				<li><a href="#trendnet">Trendnet</a></li>
				<li><a href="#uniview">Uniview</a></li>
				<li><a href="#vivotek">Vivotek</a></li>
			</ul>
			</li>
			<li><a href="#by-chipset-or-pattern">By chipset or pattern</a></li>
		</ul>
		</li>
	</ul>
</blockquote>
<hr />
<h3 id="cam-hunting">Cam hunting</h3>
<p>An exposed camera advertises itself. Its web UI ships a fixed page title (an Axis M1124 reports <code>Live view - AXIS M1124 Network Camera</code>), its stream and snapshot endpoints sit at fixed paths (the fragments from the vendor sections above), and its service banner names the software. Two search engines have already cataloged that for you. Google crawls the pages, so you hunt it there with dorks. Shodan scans the ports and keeps the banners, so you hunt it there with filters. Both lean on the same fingerprints.</p>
<blockquote class="admonition caution">
	<p class="admonition-label">Caution</p>
	<p>Treat these as discovery for cameras meant to be public (traffic, weather, and storefronts). Do not authenticate against a device you do not own, and honor robots.txt and each site's terms.</p>
</blockquote>
<h4 id="google-dorks">Google dorks</h4>
<p>Google Dorking is searching with advanced operators to surface pages an ordinary query buries. It finds cameras because both of a camera's tells, the page title and the endpoint path, get crawled and indexed whenever the device is exposed without auth. A query that pins the title, the path, or both pulls the live ones straight out of the index. Most fragments below are the same paths as the vendor schemes above, so a hit on the fragment is a hit on the camera family.</p>
<p>Build a query in layers:</p>
<ol>
	<li><strong>Path.</strong> Start from a fragment: <code>inurl:axis-cgi/mjpg/video.cgi</code>.</li>
	<li><strong>Title.</strong> Anchor it to a real page title to drop non-camera hits: <code>intitle:"Live view - AXIS"</code>.</li>
	<li><strong>Sweep.</strong> Widen across models or channels with <code>*</code>, <code>|</code>, or <code>numrange</code>.</li>
	<li><strong>Trim.</strong> Cut the vendor's own docs and demos with <code>-</code>.</li>
</ol>
<p>Layered together that reads <code>intitle:"Live view - AXIS" inurl:axis-cgi/mjpg/video.cgi -inurl:doc</code>, which returns live Axis views instead of forum threads about them.</p>
<h5 id="operators">Operators</h5>
<p>These six operators carry most camera queries. Each row pairs the operator with a camera-tuned example.</p>
<div class="table-wrap">
	<table>
		<thead>
			<tr>
				<th>operator</th>
				<th>what it does</th>
				<th>camera example</th>
			</tr>
		</thead>
		<tbody>
			<tr>
				<td><code>inurl:</code></td>
				<td>match a fragment anywhere in the URL</td>
				<td><code>inurl:axis-cgi/mjpg/video.cgi</code></td>
			</tr>
			<tr>
				<td><code>allinurl:</code></td>
				<td>require every keyword in the URL</td>
				<td><code>allinurl:cam realmonitor channel</code></td>
			</tr>
			<tr>
				<td><code>intitle:</code></td>
				<td>match words in the page title</td>
				<td><code>intitle:"Network Camera"</code></td>
			</tr>
			<tr>
				<td><code>allintitle:</code></td>
				<td>require every keyword in the title</td>
				<td><code>allintitle:live view axis</code></td>
			</tr>
			<tr>
				<td><code>site:</code></td>
				<td>restrict to a host or TLD</td>
				<td><code>site:.jp intitle:"Network Camera"</code></td>
			</tr>
			<tr>
				<td><code>numrange:</code></td>
				<td>match a number range, or the <code>X..Y</code> shorthand</td>
				<td><code>inurl:Streaming/Channels numrange:101-402</code></td>
			</tr>
		</tbody>
	</table>
</div>
<p>Combine them to go from a noisy fragment to a short list of live cameras.</p>
<p><strong>Exact phrase (<code>"..."</code>).</strong> Quote a title to match it verbatim. An Axis M1124 reports <code>Live view - AXIS M1124 Network Camera</code>, so <code>"Live view - AXIS"</code> pins the vendor without locking to one model.</p>
<p><strong>Force a term.</strong> Google retired the old <code>+</code> operator, so quote a token to insist it appears. <code>intitle:"Network Camera" "mjpg"</code> forces the literal <code>mjpg</code>.</p>
<p><strong>OR (<code>|</code>).</strong> Widen across vendor titles: <code>intitle:"Live view" | intitle:"Network Camera"</code>. Those two catch a large share of cameras on their own.</p>
<p><strong>AND (<code>&amp;</code>).</strong> Require a title and a path together: <code>intitle:"Network Camera" &amp; inurl:mjpg</code>. A plain space already means AND, so <code>intitle:"Network Camera" inurl:mjpg</code> is identical.</p>
<p><strong>Group with parens.</strong> Mix OR and AND: <code>(inurl:cam/realmonitor | inurl:Streaming/Channels) intitle:"Network Camera"</code>.</p>
<p><strong>Wildcard (<code>*</code>).</strong> Stand in for the model name. <code>intitle:"* Network Camera"</code> catches <code>AXIS M1124 Network Camera</code>, <code>D-Link Network Camera</code>, and the rest; <code>inurl:"Streaming/Channels/*/picture"</code> catches any Hikvision channel.</p>
<p><strong>Synonyms (<code>~</code>).</strong> Pull related words: <code>~live inurl:view</code> also reaches "webcam" and "streaming" pages. Google has mostly retired this, so quoting is more reliable.</p>
<p><strong>Sweep numbers (<code>..</code>).</strong> Enumerate channels and stream indexes. <code>inurl:media/video 1..8</code> reaches Uniview <code>video1</code> through <code>video8</code>; <code>inurl:Streaming/Channels/101..402</code> sweeps Hikvision channel and stream codes. The older <code>numrange:101-402</code> form still shows up in dork lists, but Google has mostly dropped it in favor of <code>..</code>.</p>
<h5 id="fragments-by-vendor">Fragments by vendor</h5>
<p><strong><a href="#axis">Axis</a>.</strong></p>
<ul>
	<li><code>axis-cgi/mjpg/video.cgi</code>, <code>viewer_index.shtml?id=</code></li>
</ul>
<p><strong><a href="#dahua-and-amcrest">Dahua and Amcrest</a>.</strong></p>
<ul>
	<li><code>cam/realmonitor?channel=1&amp;subtype=0</code>, <code>cam/realmonitor?channel=1&amp;subtype=1</code></li>
	<li><code>cgi-bin/snapshot.cgi</code>, <code>cgi-bin/snapshot.cgi?channel=1</code></li>
</ul>
<p><strong><a href="#d-link">D-Link</a> and <a href="#vivotek">Vivotek</a>.</strong> The <code>live*.sdp</code> and <code>*.mjpg</code> family.</p>
<ul>
	<li><code>video1.mjpg</code>, <code>video.mjpg</code> (also <code>?resolution=640x360</code>, <code>&amp;compression=50</code>, or <code>?timestamp=</code>)</li>
	<li><code>live3.sdp</code></li>
</ul>
<p><strong><a href="#hikvision">Hikvision</a>.</strong></p>
<ul>
	<li><code>Streaming/Channels/101</code></li>
</ul>
<p><strong><a href="#instar">INSTAR</a> and hi3510.</strong></p>
<ul>
	<li><code>tmpfs/snap.jpg</code>, <code>tmpfs/auto.jpg</code>, <code>tmpfs/auto2.jpg</code></li>
</ul>
<p><strong><a href="#lilin">LILIN</a>.</strong></p>
<ul>
	<li><code>getimage?fmt=720p</code></li>
</ul>
<p><strong><a href="#sony">Sony</a>.</strong></p>
<ul>
	<li><code>mjpeg</code> (matches the SNC snapshot path, but broad on its own)</li>
</ul>
<p><strong><a href="#trendnet">Trendnet</a>.</strong></p>
<ul>
	<li><code>video/mjpg.cgi</code></li>
</ul>
<p><strong><a href="#uniview">Uniview</a>.</strong></p>
<ul>
	<li><code>media/video&lt;N&gt;</code>, <code>media2/video&lt;N&gt;</code>, <code>video/mjpeg/stream&lt;N&gt;</code></li>
	<li><code>images/snapshot.jpg</code>, <code>images/snapshot.jpg/Channels/1/</code>, <code>images/snapshot.jpg/Channels/2/</code></li>
	<li><code>LAPI/V1.0/Channels/&lt;id&gt;/Media/Video/Streams/&lt;id&gt;/Snapshot</code></li>
	<li><code>c&lt;N&gt;/b&lt;begin&gt;/e&lt;end&gt;/replay/</code></li>
</ul>
<p><strong>Mobotix.</strong> Guest and user view pages plus the fast M-JPEG API. Not yet in the vendor list above.</p>
<ul>
	<li><code>guestimage.html</code>, <code>userimage.html</code></li>
	<li><code>faststream.jpg</code> (also <code>?stream=full&amp;fps=16</code> or <code>&amp;fps=25</code>)</li>
</ul>
<p><strong>Panasonic / i-PRO.</strong> KX-HCM and BB/BL series network cameras. Not yet in the vendor list above.</p>
<ul>
	<li><code>CgiStart?page=Single&amp;Language=0</code>, <code>index.html?Language=0&amp;ViewMode=pull</code></li>
	<li><code>nphMotionJpeg</code> (also <code>?Resolution=320x240</code> or <code>?Resolution=640x480</code>, plus <code>&amp;Quality=Standard</code> or <code>&amp;Quality=Clarity</code>)</li>
</ul>
<p><strong>Generic and unsorted.</strong> Broad fragments that match many brands, or ones not yet fingerprinted.</p>
<ul>
	<li><code>image.cgi</code>, <code>video.cgi</code> (noisy alone; pair with <code>intitle:</code>)</li>
	<li><code>video.cgi?resolution=4CIF&amp;camera=&lt;N&gt;</code> (multi-channel video server, vendor unconfirmed)</li>
	<li><code>fullsize.jpg?camera=&lt;N&gt;&amp;motion=0</code>, <code>hugesize.jpg?camera=&lt;N&gt;&amp;motion=0</code> (multi-lens JPEG server, likely Mobotix)</li>
</ul>
<h4 id="shodan-safari">Shodan safari</h4>
<p>Shodan (shodan.io) is a search engine for internet-connected devices. Rather than crawl web pages like Google, it scans the internet, connects to each open port, and records the banner the service returns. A banner is the metadata a service volunteers on connection: the server software and version, the options it supports, a welcome message, and so on. Cameras leak their model straight into that banner, which turns Shodan into a fingerprinting tool. Match the banner and you have the model.</p>
<p>A query ANDs its terms together. A bare quoted string matches anywhere in the banner, a <code>filter:value</code> pair narrows to one field, and a leading <code>-</code> excludes; <code>-401</code> drops the auth-required responses and leaves the open ones. Most filters need a free account.</p>
<div class="table-wrap">
	<table>
		<thead>
			<tr>
				<th>filter</th>
				<th>matches</th>
				<th>camera example</th>
			</tr>
		</thead>
		<tbody>
			<tr>
				<td><code>"..."</code></td>
				<td>any text in the banner</td>
				<td><code>"Server: yawcam"</code></td>
			</tr>
			<tr>
				<td><code>product:</code></td>
				<td>the software Shodan identified</td>
				<td><code>product:"D-Link DCS-930L"</code></td>
			</tr>
			<tr>
				<td><code>html:</code></td>
				<td>text in the HTTP response body</td>
				<td><code>html:"AXIS M1124 Network Camera"</code></td>
			</tr>
			<tr>
				<td><code>http.title:</code></td>
				<td>the page title</td>
				<td><code>http.title:"Network Camera"</code></td>
			</tr>
			<tr>
				<td><code>http.component:</code></td>
				<td>a detected framework or library</td>
				<td><code>http.component:"mootools"</code></td>
			</tr>
			<tr>
				<td><code>has_screenshot:</code></td>
				<td>devices with a captured screenshot</td>
				<td><code>has_screenshot:true</code></td>
			</tr>
			<tr>
				<td><code>port:</code></td>
				<td>a specific service port</td>
				<td><code>port:554</code></td>
			</tr>
		</tbody>
	</table>
</div>
<p>Known-good queries to start from:</p>
<div class="table-wrap">
	<table>
		<thead>
			<tr>
				<th>target</th>
				<th>query</th>
			</tr>
		</thead>
		<tbody>
			<tr>
				<td><em>Safari Zone!</em></td>
				<td><code>"Server: Camera"</code></td>
			</tr>
			<tr>
				<td>Samsung electronic billboards</td>
				<td><code>"Server: Prismview Player"</code></td>
			</tr>
			<tr>
				<td>Yawcam</td>
				<td><code>"Server: yawcam" "Mime-Type: text/html"</code></td>
			</tr>
			<tr>
				<td>webcamXP / webcam7</td>
				<td><code>("webcam 7" OR "webcamXP") http.component:"mootools" -401</code></td>
			</tr>
			<tr>
				<td>Android IP Webcam Server</td>
				<td><code>"Server: IP Webcam Server" "200 OK"</code></td>
			</tr>
			<tr>
				<td>Security DVRs</td>
				<td><code>html:"DVR_H264 ActiveX"</code></td>
			</tr>
			<tr>
				<td>Axis M1124</td>
				<td><code>html:"AXIS M1124 Network Camera"</code></td>
			</tr>
			<tr>
				<td>Apexis APM-H803-MPC</td>
				<td><code>product:"Apexis APM-H803-MPC"</code></td>
			</tr>
			<tr>
				<td>D-Link DCS-5020L webcam http interface</td>
				<td><code>product:"D-Link DCS-5020L webcam http interface"</code></td>
			</tr>
			<tr>
				<td>D-Link DCS-930L webcam http interface</td>
				<td><code>product:"D-Link DCS-930L webcam http interface"</code></td>
			</tr>
			<tr>
				<td>D-Link DCS-930LB1 webcam http interface</td>
				<td><code>product:"D-Link DCS-930LB1 webcam http interface"</code></td>
			</tr>
			<tr>
				<td>D-Link DCS-931L webcam http interface</td>
				<td><code>product:"D-Link DCS-931L webcam http interface"</code></td>
			</tr>
			<tr>
				<td>D-Link DCS-932L webcam http interface</td>
				<td><code>product:"D-Link DCS-932L webcam http interface"</code></td>
			</tr>
			<tr>
				<td>D-Link DCS-932LB1 webcam http interface</td>
				<td><code>product:"D-Link DCS-932LB1 webcam http interface"</code></td>
			</tr>
			<tr>
				<td>D-Link DCS-5211L</td>
				<td><code>product:"D-Link DCS-5211L"</code></td>
			</tr>
			<tr>
				<td>D-Link DCS-5222L</td>
				<td><code>product:"D-Link DCS-5222L"</code></td>
			</tr>
			<tr>
				<td>D-Link DCS-930L</td>
				<td><code>product:"D-Link DCS-930L"</code></td>
			</tr>
			<tr>
				<td>D-Link DCS-936L</td>
				<td><code>product:"D-Link DCS-936L"</code></td>
			</tr>
			<tr>
				<td>D-Link DCS-942L</td>
				<td><code>product:"D-Link DCS-942L"</code></td>
			</tr>
			<tr>
				<td>D-Link DCS-942LB1</td>
				<td><code>product:"D-Link DCS-942LB1"</code></td>
			</tr>
			<tr>
				<td>D-Link and Airlink IP</td>
				<td><code>"Server: Camera Web Server/1.0"</code></td>
			</tr>
			<tr>
				<td>D-Link/Airlink IP webcam http config</td>
				<td><code>product:"D-Link/Airlink IP webcam http config"</code></td>
			</tr>
			<tr>
				<td>D-Link webcams (others)</td>
				<td><code>"Server: alphapd"</code></td>
			</tr>
			<tr>
				<td>Dahua-based CM-Hybrid NVR 3108-I3</td>
				<td><code>product:"Dahua-based CM-Hybrid NVR 3108-I3"</code></td>
			</tr>
			<tr>
				<td>Hikvision IP Camera</td>
				<td><code>product:"Hikvision IP Camera"</code></td>
			</tr>
			<tr>
				<td>Panasonic BB-SC384B webcam http config</td>
				<td><code>product:"Panasonic BB-SC384B webcam http config"</code></td>
			</tr>
			<tr>
				<td>Panasonic BB-SW172 webcam http config</td>
				<td><code>product:"Panasonic BB-SW172 webcam http config"</code></td>
			</tr>
			<tr>
				<td>Panasonic DG-SP304 webcam http config</td>
				<td><code>product:"Panasonic DG-SP304 webcam http config"</code></td>
			</tr>
			<tr>
				<td>Panasonic WV-SC385 webcam http config</td>
				<td><code>product:"Panasonic WV-SC385 webcam http config"</code></td>
			</tr>
			<tr>
				<td>Panasonic WV-SF135 webcam http config</td>
				<td><code>product:"Panasonic WV-SF135 webcam http config"</code></td>
			</tr>
			<tr>
				<td>Panasonic WV-SW158 webcam http config</td>
				<td><code>product:"Panasonic WV-SW158 webcam http config"</code></td>
			</tr>
			<tr>
				<td>TRENDnet IP Camera</td>
				<td><code>product:"TRENDnet IP Camera"</code></td>
			</tr>
			<tr>
				<td>Trendnet TV-IP572PI</td>
				<td><code>product:"Trendnet TV-IP572PI"</code></td>
			</tr>
			<tr>
				<td>Trendnet TV-IP662WI</td>
				<td><code>product:"Trendnet TV-IP662WI"</code></td>
			</tr>
			<tr>
				<td>Trendnet TV-IP672W</td>
				<td><code>product:"Trendnet TV-IP672W"</code></td>
			</tr>
			<tr>
				<td>Trendnet TV-IP672WI</td>
				<td><code>product:"Trendnet TV-IP672WI"</code></td>
			</tr>
			<tr>
				<td>Trendnet TV-IP862IC</td>
				<td><code>product:"Trendnet TV-IP862IC"</code></td>
			</tr>
			<tr>
				<td>VCS-VideoJet-Webserver httpd</td>
				<td><code>product:"VCS-VideoJet-Webserver httpd"</code></td>
			</tr>
			<tr>
				<td>Vivotek IP7131 Network Camera http config</td>
				<td><code>product:"Vivotek IP7131 Network Camera http config"</code></td>
			</tr>
			<tr>
				<td>Yawcam webcam viewer httpd</td>
				<td><code>product:"Yawcam webcam viewer httpd"</code></td>
			</tr>
			<tr>
				<td>webcam 7 httpd</td>
				<td><code>product:"webcam 7 httpd"</code></td>
			</tr>
			<tr>
				<td>webcamXP 5</td>
				<td><code>product:"webcamXP 5"</code></td>
			</tr>
		</tbody>
	</table>
</div>
<blockquote class="admonition tip">
	<p class="admonition-label">Tip</p>
	<p>Shodan captures a screenshot from many camera services. Append <code>has_screenshot:true</code> to jump straight to the ones you can preview, and narrow to a region with <code>country:</code>, <code>city:</code>, or <code>org:</code>. Censys and ZoomEye index the same banners with similar filters.</p>
</blockquote>
<hr />
<h3 id="tips-for-viewing-web-cams">Tips for viewing web cams</h3>
<h4 id="how-to-use-this-section">How to use this section</h4>
<p>Every URL below uses these placeholders. Substitute your camera's real values.</p>
<ul>
	<li><strong><code>&lt;ip&gt;</code>:</strong> camera or NVR IP address.</li>
	<li><strong><code>&lt;port&gt;</code>:</strong> service port. RTSP defaults to <code>554</code>; HTTP defaults to <code>80</code>, though some cameras (Foscam, INSTAR) ship on <code>88</code> or <code>8080</code>.</li>
	<li><strong><code>&lt;user&gt;</code> / <code>&lt;pass&gt;</code>:</strong> camera login. Inject credentials inline: <code>rtsp://&lt;user&gt;:&lt;pass&gt;@&lt;ip&gt;:554/...</code> for RTSP, <code>http://&lt;user&gt;:&lt;pass&gt;@&lt;ip&gt;/...</code> for HTTP.</li>
</ul>
<p><strong>Main vs sub stream.</strong> Most cameras publish at least two streams. The main stream is full resolution. The sub stream is a lower-resolution copy that is cheaper to decode and lighter on bandwidth, so reach for it when you only need thumbnails or a multi-camera wall.</p>
<hr />
<h4 id="generic-patterns">Generic patterns</h4>
<p>Try these before you know the brand. They work on a large share of ONVIF-compliant cameras.</p>
<ul>
	<li><strong>RTSP main stream:</strong> <code>rtsp://&lt;user&gt;:&lt;pass&gt;@&lt;ip&gt;:554/stream1</code></li>
	<li><strong>RTSP sub stream:</strong> <code>rtsp://&lt;user&gt;:&lt;pass&gt;@&lt;ip&gt;:554/stream2</code></li>
	<li><strong>ONVIF snapshot:</strong> <code>http://&lt;ip&gt;/onvif/snapshot</code></li>
</ul>
<p>Some cameras use <code>/h264Preview_01_main</code> and <code>/h264Preview_01_sub</code> in place of <code>/stream1</code> and <code>/stream2</code>. HTTP snapshot and MJPEG paths are almost always vendor-specific, so drop down to <a href="#by-vendor">By vendor</a> when the generic ones fail.</p>
<h4 id="check-the-codec">Check the codec</h4>
<p>Some clients only decode Motion JPEG or H.264. MATLAB is one, and several lightweight players and libraries are the same. Confirm the codec in VLC before wiring a stream into anything:</p>
<ul>
	<li>Open VLC, then <strong>Media &gt; Open Network Stream</strong> and paste the RTSP URL.</li>
	<li>Open <strong>Tools &gt; Codec Information</strong>.</li>
	<li>Read the <strong>Codec</strong> field on the Codec tab. Motion JPEG or H.264 will work; anything else (H.265/HEVC is a usual culprit) will not.</li>
</ul>
<h4 id="by-vendor">By vendor</h4>
<p>Each entry lists the vendor's path scheme and any specific models confirmed to use it.</p>
<h5 id="axis">Axis</h5>
<ul>
	<li><strong>MJPEG:</strong> <code>http://&lt;ip&gt;/axis-cgi/mjpg/video.cgi</code></li>
	<li><strong>Snapshot:</strong> <code>http://&lt;ip&gt;/jpg/image.jpg</code></li>
	<li><strong>0519-004:</strong> MJPEG at <code>http://&lt;ip&gt;:&lt;port&gt;/mjpg/video.mjpg</code>.</li>
</ul>
<h5 id="cp-plus">CP Plus</h5>
<p>CP Plus speaks the Dahua realmonitor API, so treat it as Dahua-family (see <a href="#dahua-and-amcrest">Dahua and Amcrest</a>).</p>
<ul>
	<li><strong>CP-UNC-TA21PL3-V3:</strong> H.264 at <code>rtsp://&lt;ip&gt;/cam/realmonitor?channel=1&amp;subtype=0</code>, MJPEG at <code>rtsp://&lt;ip&gt;/cam/realmonitor?channel=1&amp;subtype=1</code>.</li>
</ul>
<h5 id="dahua-and-amcrest">Dahua and Amcrest</h5>
<p>Both use the Dahua HTTP and RTSP API. <code>subtype</code> selects the stream (<code>0</code> main, <code>1</code> sub); <code>channel</code> is 1-based.</p>
<ul>
	<li><strong>RTSP main:</strong> <code>rtsp://&lt;user&gt;:&lt;pass&gt;@&lt;ip&gt;:554/cam/realmonitor?channel=1&amp;subtype=0</code></li>
	<li><strong>RTSP sub:</strong> <code>rtsp://&lt;user&gt;:&lt;pass&gt;@&lt;ip&gt;:554/cam/realmonitor?channel=1&amp;subtype=1</code></li>
	<li><strong>Snapshot:</strong> <code>http://&lt;ip&gt;/cgi-bin/snapshot.cgi?channel=1</code> (drop <code>?channel=1</code> on single-channel cameras; some NVR setups require it)</li>
</ul>
<h5 id="d-link">D-Link</h5>
<ul>
	<li><strong>DCS-2132L:</strong> MJPEG at <code>http://&lt;ip&gt;:&lt;port&gt;/video1.mjpg</code>, RTSP at <code>rtsp://&lt;ip&gt;:&lt;port&gt;/live3.sdp</code>.</li>
</ul>
<h5 id="foscam">Foscam</h5>
<ul>
	<li><strong>FI9821W V2:</strong> MJPEG at <code>http://&lt;ip&gt;:&lt;port&gt;/cgi-bin/CGIStream.cgi?cmd=GetMJStream</code>.</li>
</ul>
<h5 id="hikvision">Hikvision</h5>
<p>Hikvision uses the ISAPI/Streaming scheme. The channel number encodes both channel and stream: <code>101</code> is channel 1 main, <code>102</code> is channel 1 sub.</p>
<ul>
	<li><strong>RTSP:</strong> <code>rtsp://&lt;user&gt;:&lt;pass&gt;@&lt;ip&gt;:554/Streaming/Channels/101</code></li>
	<li><strong>Snapshot:</strong> <code>http://&lt;ip&gt;/ISAPI/Streaming/Channels/101/picture</code> or <code>http://&lt;ip&gt;/onvif/snapshot</code></li>
	<li><strong>DS-2CD1240-L:</strong> <code>rtsp://&lt;ip&gt;/Streaming/Channels/101</code>.</li>
</ul>
<h5 id="instar">INSTAR</h5>
<p>RTSP streams use numeric paths and HTTP snapshots live under <code>/tmpfs/</code>. INSTAR HD models run the hi3510 chipset, so the CGI paths below turn up on rebadged cameras from other brands too (see <a href="#by-chipset-or-pattern">By chipset or pattern</a>).</p>
<ul>
	<li><strong>RTSP streams 1, 2, 3:</strong> <code>rtsp://&lt;user&gt;:&lt;pass&gt;@&lt;ip&gt;:554/11</code>, <code>/12</code>, <code>/13</code></li>
	<li><strong>MJPEG:</strong> <code>http://&lt;ip&gt;:&lt;port&gt;/cgi-bin/hi3510/mjpegstream.cgi?-chn=11&amp;-usr=&lt;user&gt;&amp;-pwd=&lt;pass&gt;</code></li>
	<li><strong>Snapshot:</strong> <code>http://&lt;user&gt;:&lt;pass&gt;@&lt;ip&gt;/tmpfs/snap.jpg</code> (also <code>/tmpfs/auto.jpg</code>, <code>/tmpfs/auto2.jpg</code>)</li>
	<li><strong>IN-9008 Full HD:</strong> confirmed with the paths above. Example: <code>rtsp://admin:instar@192.168.1.25:554/11</code>.</li>
</ul>
<h5 id="lilin">LILIN</h5>
<ul>
	<li><strong>Stream:</strong> <code>http://&lt;ip&gt;/getimage?fmt=720p</code></li>
</ul>
<h5 id="sony">Sony</h5>
<ul>
	<li><strong>SNC-CH110:</strong> MJPEG at <code>http://&lt;ip&gt;:&lt;port&gt;/mjpeg</code>.</li>
</ul>
<h5 id="trendnet">Trendnet</h5>
<ul>
	<li><strong>TV-IP572WI:</strong> MJPEG at <code>http://&lt;ip&gt;:&lt;port&gt;/video/mjpg.cgi</code>.</li>
</ul>
<h5 id="uniview">Uniview</h5>
<p>Uniview (UNV) covers both standalone cameras (IPC) and NVRs, and the paths differ between the two.</p>
<p><strong>NVR</strong></p>
<ul>
	<li><strong>Live view:</strong> <code>rtsp://&lt;ip&gt;:554/unicast/c&lt;N&gt;/s&lt;M&gt;/live</code>, where <code>c1</code> is channel 1 and <code>c10</code> is channel 10, <code>s0</code> is the main stream and <code>s1</code> is the sub stream.</li>
	<li><strong>Playback:</strong> <code>rtsp://&lt;ip&gt;:554/c&lt;N&gt;/b&lt;begin&gt;/e&lt;end&gt;/replay/</code>, where <code>begin</code> and <code>end</code> are Unix timestamps. Example: <code>rtsp://187.72.216.229:554/c2/b1544574378/e1544578706/replay/</code>.</li>
	<li><strong>Snapshot:</strong> <code>http://&lt;ip&gt;/LAPI/V1.0/Channels/&lt;id&gt;/Media/Video/Streams/&lt;id&gt;/Snapshot</code>. Example: <code>http://172.1.90.251/LAPI/V1.0/Channels/12/Media/Video/Streams/0/Snapshot</code>. Enable snapshot on the IPC first; this needs a UNV NVR paired with a UNV IPC.</li>
</ul>
<p><strong>IPC (standalone camera)</strong></p>
<ul>
	<li><strong>Live view:</strong> <code>rtsp://&lt;ip&gt;:554/media/video1</code> (main), <code>/media/video2</code> (sub), <code>/media/video3</code> (third). With auth: <code>rtsp://&lt;user&gt;:&lt;pass&gt;@&lt;ip&gt;:&lt;port&gt;/media/video&lt;N&gt;</code>.</li>
	<li><strong>MJPEG:</strong> <code>http://&lt;ip&gt;/video/mjpeg/stream1</code> (or <code>stream2</code>, <code>stream3</code>).</li>
	<li><strong>Snapshot:</strong> <code>http://&lt;ip&gt;/images/snapshot.jpg</code>.</li>
</ul>
<p><strong>Multi-sensor bodies</strong></p>
<ul>
	<li><strong>Fisheye:</strong> <code>video1</code> main, <code>video2</code> sub, <code>video3</code> third.</li>
	<li><strong>4PTZ:</strong> <code>video4</code> through <code>video7</code>.</li>
	<li><strong>Panorama:</strong> <code>video8</code>.</li>
	<li><strong>Dual-lens live view:</strong> first lens at <code>/media/video1</code>, <code>/media/video2</code>, <code>/media/video3</code>; second lens at <code>/media2/video1</code>, <code>/media2/video2</code>, <code>/media2/video3</code>.</li>
	<li><strong>Dual-lens snapshot:</strong> <code>http://&lt;ip&gt;/images/snapshot.jpg/Channels/1/</code> and <code>.../Channels/2/</code>.</li>
</ul>
<h5 id="vivotek">Vivotek</h5>
<ul>
	<li><strong>IB8168:</strong> MJPEG at <code>http://&lt;ip&gt;:&lt;port&gt;/video.mjpg</code>, RTSP at <code>rtsp://&lt;ip&gt;:&lt;port&gt;/live3.sdp</code>.</li>
</ul>
<hr />
<h4 id="by-chipset-or-pattern">By chipset or pattern</h4>
<p>For cameras you cannot pin down to an exact model, record the URL scheme and any chipset fingerprint. These families cross brands, so a match narrows the guess even with no model number.</p>
<ul>
	<li><strong>Dahua realmonitor API.</strong> Paths like <code>/cam/realmonitor?channel=1&amp;subtype=0</code>. Native on Dahua and Amcrest, and also seen on CP Plus and many rebadged OEM cameras. If <code>realmonitor</code> responds, treat the camera as Dahua-family.</li>
	<li><strong>hi3510 chipset.</strong> CGI under <code>/cgi-bin/hi3510/</code> (for example <code>mjpegstream.cgi</code>) plus snapshots at <code>/tmpfs/snap.jpg</code>, <code>/tmpfs/auto.jpg</code>, and <code>/tmpfs/auto2.jpg</code>. Native on INSTAR HD models and common on other HiSilicon-based rebadges.</li>
	<li><strong><code>live3.sdp</code> RTSP.</strong> Seen on the D-Link DCS-2132L and Vivotek IB8168. A <code>liveN.sdp</code> path points at one of these families or an OEM cousin.</li>
	<li><strong>Uniview <code>/media/videoN</code>.</strong> Numbered media paths, <code>video1</code> / <code>video2</code> / <code>video3</code> for main / sub / third.</li>
</ul>
<p>When you find a new one, note the working URL, the protocol, the codec (from VLC), the default port, and anything the login page or HTTP response headers reveal (the <code>Server</code> header, the auth realm, or on-page branding). That is usually enough to slot the camera into a family later.</p>
`;
