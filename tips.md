# Tips

> ### Table of Contents
> - [Cam hunting](#cam-hunting)
>   - [Google dorks](#google-dorks)
>   - [Shodan safari](#shodan-safari)
> - [Tips for viewing web cams](#tips-for-viewing-web-cams)
>    - [How to use this section](#how-to-use-this-section)
>    - [Generic patterns](#generic-patterns)
>    - [Check the codec](#check-the-codec)
>    - [By vendor](#by-vendor)
>      - [Axis](#axis)
>      - [CP Plus](#cp-plus)
>      - [Dahua and Amcrest](#dahua-and-amcrest)
>      - [D-Link](#d-link)
>      - [Foscam](#foscam)
>      - [Hikvision](#hikvision)
>      - [INSTAR](#instar)
>      - [LILIN](#lilin)
>      - [Sony](#sony)
>      - [Trendnet](#trendnet)
>      - [Uniview](#uniview)
>      - [Vivotek](#vivotek)
>    - [By chipset or pattern](#by-chipset-or-pattern)

---

## Cam hunting

An exposed camera advertises itself. Its web UI ships a fixed page title (an Axis M1124 reports `Live view - AXIS M1124 Network Camera`), its stream and snapshot endpoints sit at fixed paths (the fragments from the vendor sections above), and its service banner names the software. Two search engines have already cataloged that for you. Google crawls the pages, so you hunt it there with dorks. Shodan scans the ports and keeps the banners, so you hunt it there with filters. Both lean on the same fingerprints.

> [!CAUTION]
> Treat these as discovery for cameras meant to be public (traffic, weather, and storefronts). Do not authenticate against a device you do not own, and honor robots.txt and each site's terms.

### Google dorks

Google Dorking is searching with advanced operators to surface pages an ordinary query buries. It finds cameras because both of a camera's tells, the page title and the endpoint path, get crawled and indexed whenever the device is exposed without auth. A query that pins the title, the path, or both pulls the live ones straight out of the index. Most fragments below are the same paths as the vendor schemes above, so a hit on the fragment is a hit on the camera family.

Build a query in layers:

1. **Path.** Start from a fragment: `inurl:axis-cgi/mjpg/video.cgi`.
2. **Title.** Anchor it to a real page title to drop non-camera hits: `intitle:"Live view - AXIS"`.
3. **Sweep.** Widen across models or channels with `*`, `|`, or `numrange`.
4. **Trim.** Cut the vendor's own docs and demos with `-`.

Layered together that reads `intitle:"Live view - AXIS" inurl:axis-cgi/mjpg/video.cgi -inurl:doc`, which returns live Axis views instead of forum threads about them.

#### Operators

These six operators carry most camera queries. Each row pairs the operator with a camera-tuned example.

| operator | what it does | camera example |
|---|---|---|
| `inurl:` | match a fragment anywhere in the URL | `inurl:axis-cgi/mjpg/video.cgi` |
| `allinurl:` | require every keyword in the URL | `allinurl:cam realmonitor channel` |
| `intitle:` | match words in the page title | `intitle:"Network Camera"` |
| `allintitle:` | require every keyword in the title | `allintitle:live view axis` |
| `site:` | restrict to a host or TLD | `site:.jp intitle:"Network Camera"` |
| `numrange:` | match a number range, or the `X..Y` shorthand | `inurl:Streaming/Channels numrange:101-402` |

Combine them to go from a noisy fragment to a short list of live cameras.

**Exact phrase (`"..."`).** Quote a title to match it verbatim. An Axis M1124 reports `Live view - AXIS M1124 Network Camera`, so `"Live view - AXIS"` pins the vendor without locking to one model.

**Force a term.** Google retired the old `+` operator, so quote a token to insist it appears. `intitle:"Network Camera" "mjpg"` forces the literal `mjpg`.

**OR (`|`).** Widen across vendor titles: `intitle:"Live view" | intitle:"Network Camera"`. Those two catch a large share of cameras on their own.

**AND (`&`).** Require a title and a path together: `intitle:"Network Camera" & inurl:mjpg`. A plain space already means AND, so `intitle:"Network Camera" inurl:mjpg` is identical.

**Group with parens.** Mix OR and AND: `(inurl:cam/realmonitor | inurl:Streaming/Channels) intitle:"Network Camera"`.

**Wildcard (`*`).** Stand in for the model name. `intitle:"* Network Camera"` catches `AXIS M1124 Network Camera`, `D-Link Network Camera`, and the rest; `inurl:"Streaming/Channels/*/picture"` catches any Hikvision channel.

**Synonyms (`~`).** Pull related words: `~live inurl:view` also reaches "webcam" and "streaming" pages. Google has mostly retired this, so quoting is more reliable.

**Sweep numbers (`..`).** Enumerate channels and stream indexes. `inurl:media/video 1..8` reaches Uniview `video1` through `video8`; `inurl:Streaming/Channels/101..402` sweeps Hikvision channel and stream codes. The older `numrange:101-402` form still shows up in dork lists, but Google has mostly dropped it in favor of `..`.

#### Fragments by vendor

**[Axis](#axis).**

- `axis-cgi/mjpg/video.cgi`, `viewer_index.shtml?id=`

**[Dahua and Amcrest](#dahua-and-amcrest).**

- `cam/realmonitor?channel=1&subtype=0`, `cam/realmonitor?channel=1&subtype=1`
- `cgi-bin/snapshot.cgi`, `cgi-bin/snapshot.cgi?channel=1`

**[D-Link](#d-link) and [Vivotek](#vivotek).** The `live*.sdp` and `*.mjpg` family.

- `video1.mjpg`, `video.mjpg` (also `?resolution=640x360`, `&compression=50`, or `?timestamp=`)
- `live3.sdp`

**[Hikvision](#hikvision).**

- `Streaming/Channels/101`

**[INSTAR](#instar) and hi3510.**

- `tmpfs/snap.jpg`, `tmpfs/auto.jpg`, `tmpfs/auto2.jpg`

**[LILIN](#lilin).**

- `getimage?fmt=720p`

**[Sony](#sony).**

- `mjpeg` (matches the SNC snapshot path, but broad on its own)

**[Trendnet](#trendnet).**

- `video/mjpg.cgi`

**[Uniview](#uniview).**

- `media/video<N>`, `media2/video<N>`, `video/mjpeg/stream<N>`
- `images/snapshot.jpg`, `images/snapshot.jpg/Channels/1/`, `images/snapshot.jpg/Channels/2/`
- `LAPI/V1.0/Channels/<id>/Media/Video/Streams/<id>/Snapshot`
- `c<N>/b<begin>/e<end>/replay/`

**Mobotix.** Guest and user view pages plus the fast M-JPEG API. Not yet in the vendor list above.

- `guestimage.html`, `userimage.html`
- `faststream.jpg` (also `?stream=full&fps=16` or `&fps=25`)

**Panasonic / i-PRO.** KX-HCM and BB/BL series network cameras. Not yet in the vendor list above.

- `CgiStart?page=Single&Language=0`, `index.html?Language=0&ViewMode=pull`
- `nphMotionJpeg` (also `?Resolution=320x240` or `?Resolution=640x480`, plus `&Quality=Standard` or `&Quality=Clarity`)

**Generic and unsorted.** Broad fragments that match many brands, or ones not yet fingerprinted.

- `image.cgi`, `video.cgi` (noisy alone; pair with `intitle:`)
- `video.cgi?resolution=4CIF&camera=<N>` (multi-channel video server, vendor unconfirmed)
- `fullsize.jpg?camera=<N>&motion=0`, `hugesize.jpg?camera=<N>&motion=0` (multi-lens JPEG server, likely Mobotix)

### Shodan safari

Shodan (shodan.io) is a search engine for internet-connected devices. Rather than crawl web pages like Google, it scans the internet, connects to each open port, and records the banner the service returns. A banner is the metadata a service volunteers on connection: the server software and version, the options it supports, a welcome message, and so on. Cameras leak their model straight into that banner, which turns Shodan into a fingerprinting tool. Match the banner and you have the model.

A query ANDs its terms together. A bare quoted string matches anywhere in the banner, a `filter:value` pair narrows to one field, and a leading `-` excludes; `-401` drops the auth-required responses and leaves the open ones. Most filters need a free account.

| filter | matches | camera example |
|---|---|---|
| `"..."` | any text in the banner | `"Server: yawcam"` |
| `product:` | the software Shodan identified | `product:"D-Link DCS-930L"` |
| `html:` | text in the HTTP response body | `html:"AXIS M1124 Network Camera"` |
| `http.title:` | the page title | `http.title:"Network Camera"` |
| `http.component:` | a detected framework or library | `http.component:"mootools"` |
| `has_screenshot:` | devices with a captured screenshot | `has_screenshot:true` |
| `port:` | a specific service port | `port:554` |

Known-good queries to start from:

| target | query |
|---|---|
| _Safari Zone!_ | `"Server: Camera"` |
| Samsung electronic billboards | `"Server: Prismview Player"` |
| Yawcam | `"Server: yawcam" "Mime-Type: text/html"` |
| webcamXP / webcam7 | `("webcam 7" OR "webcamXP") http.component:"mootools" -401` |
| Android IP Webcam Server | `"Server: IP Webcam Server" "200 OK"` |
| Security DVRs | `html:"DVR_H264 ActiveX"` |
| Axis M1124 | `html:"AXIS M1124 Network Camera"` |
| Apexis APM-H803-MPC | `product:"Apexis APM-H803-MPC"` |
| D-Link DCS-5020L webcam http interface | `product:"D-Link DCS-5020L webcam http interface"` |
| D-Link DCS-930L webcam http interface | `product:"D-Link DCS-930L webcam http interface"` |
| D-Link DCS-930LB1 webcam http interface | `product:"D-Link DCS-930LB1 webcam http interface"` |
| D-Link DCS-931L webcam http interface | `product:"D-Link DCS-931L webcam http interface"` |
| D-Link DCS-932L webcam http interface | `product:"D-Link DCS-932L webcam http interface"` |
| D-Link DCS-932LB1 webcam http interface | `product:"D-Link DCS-932LB1 webcam http interface"` |
| D-Link DCS-5211L | `product:"D-Link DCS-5211L"` |
| D-Link DCS-5222L | `product:"D-Link DCS-5222L"` |
| D-Link DCS-930L | `product:"D-Link DCS-930L"` |
| D-Link DCS-936L | `product:"D-Link DCS-936L"` |
| D-Link DCS-942L | `product:"D-Link DCS-942L"` |
| D-Link DCS-942LB1 | `product:"D-Link DCS-942LB1"` |
| D-Link and Airlink IP | `"Server: Camera Web Server/1.0"` |
| D-Link/Airlink IP webcam http config | `product:"D-Link/Airlink IP webcam http config"` |
| D-Link webcams (others) | `"Server: alphapd"` |
| Dahua-based CM-Hybrid NVR 3108-I3 | `product:"Dahua-based CM-Hybrid NVR 3108-I3"` |
| Hikvision IP Camera | `product:"Hikvision IP Camera"` |
| Panasonic BB-SC384B webcam http config | `product:"Panasonic BB-SC384B webcam http config"` |
| Panasonic BB-SW172 webcam http config | `product:"Panasonic BB-SW172 webcam http config"` |
| Panasonic DG-SP304 webcam http config | `product:"Panasonic DG-SP304 webcam http config"` |
| Panasonic WV-SC385 webcam http config | `product:"Panasonic WV-SC385 webcam http config"` |
| Panasonic WV-SF135 webcam http config | `product:"Panasonic WV-SF135 webcam http config"` |
| Panasonic WV-SW158 webcam http config | `product:"Panasonic WV-SW158 webcam http config"` |
| TRENDnet IP Camera | `product:"TRENDnet IP Camera"` |
| Trendnet TV-IP572PI | `product:"Trendnet TV-IP572PI"` |
| Trendnet TV-IP662WI | `product:"Trendnet TV-IP662WI"` |
| Trendnet TV-IP672W | `product:"Trendnet TV-IP672W"` |
| Trendnet TV-IP672WI | `product:"Trendnet TV-IP672WI"` |
| Trendnet TV-IP862IC | `product:"Trendnet TV-IP862IC"` |
| VCS-VideoJet-Webserver httpd | `product:"VCS-VideoJet-Webserver httpd"` |
| Vivotek IP7131 Network Camera http config | `product:"Vivotek IP7131 Network Camera http config"` |
| Yawcam webcam viewer httpd | `product:"Yawcam webcam viewer httpd"` |
| webcam 7 httpd | `product:"webcam 7 httpd"` |
| webcamXP 5 | `product:"webcamXP 5"` |

> [!TIP]
> Shodan captures a screenshot from many camera services. Append `has_screenshot:true` to jump straight to the ones you can preview, and narrow to a region with `country:`, `city:`, or `org:`. Censys and ZoomEye index the same banners with similar filters.

---

## Tips for viewing web cams

### How to use this section

Every URL below uses these placeholders. Substitute your camera's real values.

- **`<ip>`:** camera or NVR IP address.
- **`<port>`:** service port. RTSP defaults to `554`; HTTP defaults to `80`, though some cameras (Foscam, INSTAR) ship on `88` or `8080`.
- **`<user>` / `<pass>`:** camera login. Inject credentials inline: `rtsp://<user>:<pass>@<ip>:554/...` for RTSP, `http://<user>:<pass>@<ip>/...` for HTTP.

**Main vs sub stream.** Most cameras publish at least two streams. The main stream is full resolution. The sub stream is a lower-resolution copy that is cheaper to decode and lighter on bandwidth, so reach for it when you only need thumbnails or a multi-camera wall.

---

### Generic patterns

Try these before you know the brand. They work on a large share of ONVIF-compliant cameras.

- **RTSP main stream:** `rtsp://<user>:<pass>@<ip>:554/stream1`
- **RTSP sub stream:** `rtsp://<user>:<pass>@<ip>:554/stream2`
- **ONVIF snapshot:** `http://<ip>/onvif/snapshot`

Some cameras use `/h264Preview_01_main` and `/h264Preview_01_sub` in place of `/stream1` and `/stream2`. HTTP snapshot and MJPEG paths are almost always vendor-specific, so drop down to [By vendor](#by-vendor) when the generic ones fail.

### Check the codec

Some clients only decode Motion JPEG or H.264. MATLAB is one, and several lightweight players and libraries are the same. Confirm the codec in VLC before wiring a stream into anything:

- Open VLC, then **Media > Open Network Stream** and paste the RTSP URL.
- Open **Tools > Codec Information**.
- Read the **Codec** field on the Codec tab. Motion JPEG or H.264 will work; anything else (H.265/HEVC is a usual culprit) will not.

### By vendor

Each entry lists the vendor's path scheme and any specific models confirmed to use it.

#### Axis

- **MJPEG:** `http://<ip>/axis-cgi/mjpg/video.cgi`
- **Snapshot:** `http://<ip>/jpg/image.jpg`

- **0519-004:** MJPEG at `http://<ip>:<port>/mjpg/video.mjpg`.

#### CP Plus

CP Plus speaks the Dahua realmonitor API, so treat it as Dahua-family (see [Dahua and Amcrest](#dahua-and-amcrest)).

- **CP-UNC-TA21PL3-V3:** H.264 at `rtsp://<ip>/cam/realmonitor?channel=1&subtype=0`, MJPEG at `rtsp://<ip>/cam/realmonitor?channel=1&subtype=1`.

#### Dahua and Amcrest

Both use the Dahua HTTP and RTSP API. `subtype` selects the stream (`0` main, `1` sub); `channel` is 1-based.

- **RTSP main:** `rtsp://<user>:<pass>@<ip>:554/cam/realmonitor?channel=1&subtype=0`
- **RTSP sub:** `rtsp://<user>:<pass>@<ip>:554/cam/realmonitor?channel=1&subtype=1`
- **Snapshot:** `http://<ip>/cgi-bin/snapshot.cgi?channel=1` (drop `?channel=1` on single-channel cameras; some NVR setups require it)

#### D-Link

- **DCS-2132L:** MJPEG at `http://<ip>:<port>/video1.mjpg`, RTSP at `rtsp://<ip>:<port>/live3.sdp`.

#### Foscam

- **FI9821W V2:** MJPEG at `http://<ip>:<port>/cgi-bin/CGIStream.cgi?cmd=GetMJStream`.

#### Hikvision

Hikvision uses the ISAPI/Streaming scheme. The channel number encodes both channel and stream: `101` is channel 1 main, `102` is channel 1 sub.

- **RTSP:** `rtsp://<user>:<pass>@<ip>:554/Streaming/Channels/101`
- **Snapshot:** `http://<ip>/ISAPI/Streaming/Channels/101/picture` or `http://<ip>/onvif/snapshot`

- **DS-2CD1240-L:** `rtsp://<ip>/Streaming/Channels/101`.

#### INSTAR

RTSP streams use numeric paths and HTTP snapshots live under `/tmpfs/`. INSTAR HD models run the hi3510 chipset, so the CGI paths below turn up on rebadged cameras from other brands too (see [By chipset or pattern](#by-chipset-or-pattern)).

- **RTSP streams 1, 2, 3:** `rtsp://<user>:<pass>@<ip>:554/11`, `/12`, `/13`
- **MJPEG:** `http://<ip>:<port>/cgi-bin/hi3510/mjpegstream.cgi?-chn=11&-usr=<user>&-pwd=<pass>`
- **Snapshot:** `http://<user>:<pass>@<ip>/tmpfs/snap.jpg` (also `/tmpfs/auto.jpg`, `/tmpfs/auto2.jpg`)

- **IN-9008 Full HD:** confirmed with the paths above. Example: `rtsp://admin:instar@192.168.1.25:554/11`.

#### LILIN

- **Stream:** `http://<ip>/getimage?fmt=720p`

#### Sony

- **SNC-CH110:** MJPEG at `http://<ip>:<port>/mjpeg`.

#### Trendnet

- **TV-IP572WI:** MJPEG at `http://<ip>:<port>/video/mjpg.cgi`.

#### Uniview

Uniview (UNV) covers both standalone cameras (IPC) and NVRs, and the paths differ between the two.

**NVR**

- **Live view:** `rtsp://<ip>:554/unicast/c<N>/s<M>/live`, where `c1` is channel 1 and `c10` is channel 10, `s0` is the main stream and `s1` is the sub stream.
- **Playback:** `rtsp://<ip>:554/c<N>/b<begin>/e<end>/replay/`, where `begin` and `end` are Unix timestamps. Example: `rtsp://187.72.216.229:554/c2/b1544574378/e1544578706/replay/`.
- **Snapshot:** `http://<ip>/LAPI/V1.0/Channels/<id>/Media/Video/Streams/<id>/Snapshot`. Example: `http://172.1.90.251/LAPI/V1.0/Channels/12/Media/Video/Streams/0/Snapshot`. Enable snapshot on the IPC first; this needs a UNV NVR paired with a UNV IPC.

**IPC (standalone camera)**

- **Live view:** `rtsp://<ip>:554/media/video1` (main), `/media/video2` (sub), `/media/video3` (third). With auth: `rtsp://<user>:<pass>@<ip>:<port>/media/video<N>`.
- **MJPEG:** `http://<ip>/video/mjpeg/stream1` (or `stream2`, `stream3`).
- **Snapshot:** `http://<ip>/images/snapshot.jpg`.

**Multi-sensor bodies**

- **Fisheye:** `video1` main, `video2` sub, `video3` third.
- **4PTZ:** `video4` through `video7`.
- **Panorama:** `video8`.
- **Dual-lens live view:** first lens at `/media/video1`, `/media/video2`, `/media/video3`; second lens at `/media2/video1`, `/media2/video2`, `/media2/video3`.
- **Dual-lens snapshot:** `http://<ip>/images/snapshot.jpg/Channels/1/` and `.../Channels/2/`.

#### Vivotek

- **IB8168:** MJPEG at `http://<ip>:<port>/video.mjpg`, RTSP at `rtsp://<ip>:<port>/live3.sdp`.

---

### By chipset or pattern

For cameras you cannot pin down to an exact model, record the URL scheme and any chipset fingerprint. These families cross brands, so a match narrows the guess even with no model number.

- **Dahua realmonitor API.** Paths like `/cam/realmonitor?channel=1&subtype=0`. Native on Dahua and Amcrest, and also seen on CP Plus and many rebadged OEM cameras. If `realmonitor` responds, treat the camera as Dahua-family.
- **hi3510 chipset.** CGI under `/cgi-bin/hi3510/` (for example `mjpegstream.cgi`) plus snapshots at `/tmpfs/snap.jpg`, `/tmpfs/auto.jpg`, and `/tmpfs/auto2.jpg`. Native on INSTAR HD models and common on other HiSilicon-based rebadges.
- **`live3.sdp` RTSP.** Seen on the D-Link DCS-2132L and Vivotek IB8168. A `liveN.sdp` path points at one of these families or an OEM cousin.
- **Uniview `/media/videoN`.** Numbered media paths, `video1` / `video2` / `video3` for main / sub / third.

When you find a new one, note the working URL, the protocol, the codec (from VLC), the default port, and anything the login page or HTTP response headers reveal (the `Server` header, the auth realm, or on-page branding). That is usually enough to slot the camera into a family later.

