# awesome-embedded-security
Awesome list for embedded security tools and knowledge

## Software Tools

### Binary Parsing and Analysis Tools
* [Kaitai Struct](https://kaitai.io/) - Kaitai Struct is a declarative language used to describe various binary data structures, laid out in files or in memory: i.e. binary file formats, network stream packet formats, etc.
* [Binwalk](https://github.com/ReFirmLabs/binwalk) - Binwalk is a fast, easy to use tool for analyzing, reverse engineering, and extracting firmware images.
* [OFRAK](https://github.com/redballoonsecurity/ofrak) - OFRAK is a binary analysis and modification platform that combines the ability to unpack, analyze, modify, and repack binaries.

### Disassember/Decompilers
* [IDA Pro](https://hex-rays.com/ida-pro/) - IDA Pro as a disassembler is capable of creating maps of their execution to show the binary instructions that are actually executed by the processor in a symbolic representation (assembly language). Advanced techniques have been implemented into IDA Pro so that it can generate assembly language source code from machine-executable code and make this complex code more human-readable.
* [Vivisect](https://github.com/vivisect/vivisect) - A combined disassembler/static analysis/symbolic execution/debugger framework.
* [Binary Ninja](https://binary.ninja/) - Binary Ninja is an interactive disassembler, decompiler, and binary analysis platform for reverse engineers, malware analysts, vulnerability researchers, and software developers that runs on Windows, macOS, and Linux.
* [Cutter](https://cutter.re/) - Free and Open Source RE Platform powered by Rizin
* [Rizin](https://rizin.re/) - A free and open-source Reverse Engineering framework, providing a complete binary analysis experience with features like Disassembler, Hexadecimal editor, Emulation, Binary inspection, Debugger, and more.
* [radare2](https://www.radare.org/n/) - A free/libre toolchain for easing several low level tasks like forensics, software reverse engineering, exploiting, debugging. It is composed by a bunch of libraries (which are extended with plugins) and programs that can be automated with almost any programming language.
* [Ghidra](https://ghidra-sre.org/) - A software reverse engineering (SRE) suite of tools developed by NSA's Research Directorate in support of the Cybersecurity mission.
* [Angr Management](https://github.com/angr/angr-management) - Angr is a multi-architecture binary analysis toolkit, with the capability to perform dynamic symbolic execution (like Mayhem, KLEE, etc.) and various static analyses on binaries. If you'd like to learn how to use it, you're in the right place!

### Language Specific Decompilers
* .NET
  * [ILSpy](https://github.com/icsharpcode/ILSpy) - .NET Decompiler with support for PDB generation, ReadyToRun, Metadata (&more) - cross-platform!
  * dnSpy
  * de4dot
* Java
  * JD-GUI
  * JADX

### Security Auditing Frameworks
* [EXPLIoT](https://pypi.org/project/expliot/) - EXPLIoT is a Framework for security testing and exploiting IoT products and IoT infrastructure. It provides a set of plugins (test cases) which are used to perform the assessment and can be extended easily with new ones. The name EXPLIoT (pronounced expl-aa-yo-tee) is a pun on the word exploit and explains the purpose of the framework i.e. IoT exploitation.
* [Metasploit](https://www.metasploit.com/) - Knowledge is power, especially when it’s shared. A collaboration between the open source community and Rapid7, Metasploit helps security teams do more than just verify vulnerabilities, manage security assessments, and improve security awareness; it empowers and arms defenders to always stay one step (or two) ahead of the game.
* [Firmware Analysis and Comparison Tool (FACT)](https://fkie-cad.github.io/FACT_core/) - The Firmware Analysis and Comparison Tool (FACT) is intended to automate Firmware Security analysis (Router, IoT, UEFI, Webcams, Drones, …). Thereby it shall be easy to use (web UI), extend (plug-in system) and integrate (REST API).
* [FwAnalyzer (Firmware Analyzer)](https://github.com/cruise-automation/fwanalyzer) - FwAnalyzer is a tool to analyze (ext2/3/4), FAT/VFat, SquashFS, UBIFS filesystem images, cpio archives, and directory content using a set of configurable rules. FwAnalyzer relies on e2tools for ext filesystems, mtools for FAT filesystems, squashfs-tools for SquashFS filesystems, and ubi_reader for UBIFS filesystems. cpio for cpio archives. SELinux/Capability support for ext2/3/4 images requires a patched version of e2tools. SELinux/Capability support for SquashFS images requires a patched version of squashfs-tools.

## Hardware Tools

### Hardware Reverse Engineering Mulitools
* [Tiguard](https://github.com/tigard-tools/tigard) - An FTDI FT2232H-based multi-protocol tool for hardware hacking.
* [Bus Pirate](https://github.com/BusPirate/Bus_Pirate) - The Bus Pirate is an open source hacker multi-tool that talks to electronic stuff. It's got a bunch of features an intrepid hacker might need to prototype their next project.

### Logic Analyzer
* [Saleae](https://www.saleae.com/) - Saleae logic analyzers are used by electrical engineers, firmware developers, enthusiasts, and engineering students to record, measure, visualize, and decode the signals in their electrical circuits.

### RF Tools (Non-SDR)

* [Flipper Zero](https://flipperzero.one/) - Flipper Zero is a portable multi-tool for pentesters and geeks in a toy-like body. It loves hacking digital stuff, such as radio protocols, access control systems, hardware and more. It's fully open-source and customizable, so you can extend it in whatever way you like.
* [Awesome Flipper Zero](https://github.com/RogueMaster/awesome-flipperzero-withModules) - A collection of Awesome resources for the Flipper Zero device.
* [Yard Stick One](https://greatscottgadgets.com/yardstickone/) - YARD Stick One (Yet Another Radio Dongle) can transmit or receive digital wireless signals at frequencies below 1 GHz. It uses the same radio circuit as the popular IM-Me. The radio functions that are possible by customizing IM-Me firmware are now at your fingertips when you attach YARD Stick One to a computer via USB.
* [Proxmark](https://proxmark.com/) - The Proxmark is an RFID swiss-army tool, allowing for both high and low level interactions with the vast majority of RFID tags and systems world-wide. Originally built by Jonathan Westhues over 10 years ago, the device has progressively evolved into the industry standard tool for RFID Analysis.

### Software Defined Radio
* [HackRF One](https://greatscottgadgets.com/hackrf/) - HackRF One from Great Scott Gadgets is a Software Defined Radio peripheral capable of transmission or reception of radio signals from 1 MHz to 6 GHz. Designed to enable test and development of modern and next generation radio technologies, HackRF One is an open source hardware platform that can be used as a USB peripheral or programmed for stand-alone operation.
* [ADALM-PLUTO (PlutoSDR)](https://www.analog.com/en/design-center/evaluation-hardware-and-software/evaluation-boards-kits/adalm-pluto.html) - The easy to use ADALM-PLUTO active learning module (PlutoSDR) helps introduce electrical engineering students to the fundamentals of software-defined radio (SDR), radio frequency (RF), and wireless communications. Designed for students at all levels and from all backgrounds, the module can be used for both instructor-led and self-directed learning to help students develop a foundation in real-world RF and communications that they can build on as they pursue science, technology, or engineering degrees.
* [RTL-SDR](https://www.rtl-sdr.com/) - RTL-SDR is a very cheap ~$30 USB dongle that can be used as a computer based radio scanner for receiving live radio signals in your area (no internet required). Depending on the particular model it could receive frequencies from 500 kHz up to 1.75 GHz. Most software for the RTL-SDR is also community developed, and provided free of charge. Note that RTL-SDRs cannot transmit.

### Wifi Tools
* [Pwnagotchi](https://pwnagotchi.ai/) - Pwnagotchi is an A2C-based “AI” powered by bettercap and running on a Raspberry Pi Zero W that learns from its surrounding WiFi environment in order to maximize the crackable WPA key material it captures (either through passive sniffing or by performing deauthentication and association attacks). This material is collected on disk as PCAP files containing any form of handshake supported by hashcat, including full and half WPA handshakes as well as PMKIDs.

## Further Learning
* [Embeddedsecurity.io](https://embeddedsecurity.io/) - We aim to provide a beginners resource on embedded systems security.

## Search Engines
![image](https://user-images.githubusercontent.com/89217603/189990679-49ddd4fb-12ea-4959-a296-63c726e179d8.png)


## Contribute

Contributions welcome! Read the [contribution guidelines](contributing.md) first.

## License

[![CC0](https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/cc-zero.svg)](https://creativecommons.org/publicdomain/zero/1.0/)
