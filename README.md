# Hashcat Grighpic Benchmark Dataset

This project collects and displays Hashcat benchmark results on the almost GPU. You can find detailed benchmark output in the file `benchmarks/etc..`

## Visualization

You can use the scripts in this project to visualize the benchmark results. Example image below:

![Benchmark Visualization Example](images/Hash_Mode_0.png)

## Custom Visualization

You can visit the [online visualization page](https://dosoos.github.io/hashcat_speeds/pages/index.html) to customize the hash type and view speed rankings and comparison charts.

This page supports filtering and sorting by various Hash-Modes, making it easy to compare the performance of different GPUs on different algorithms.

## How to Add Your Benchmark Text

### Option 1 — Submit on the website (recommended, no Git/PR needed)

1. Run the benchmark:
   ```
   hashcat -b --benchmark-all > YourGPUModel.txt
   ```
2. Open the [online visualization page](https://dosoos.github.io/hashcat_speeds/pages/index.html)
   and click **Submit Benchmark**.
3. Enter your GPU model (e.g. `RTX4090`), optionally your name, and paste the
   full contents of `YourGPUModel.txt`.
4. Click **Submit**. The output is validated in a
   [Cloudflare Worker](worker/), committed directly to `benchmarks/`, and the
   GitHub Action automatically regenerates `pages/datas.json` and the charts.

The submit button only appears once the page has been configured with a worker
URL (see [worker/README.md](worker/README.md) for deployment).

### Option 2 — Submit via Pull Request

1. **Prepare Your Benchmark Results**  
   Run the Hashcat benchmark, for example:
   ```
   hashcat -b --benchmark-all > benchmarks/YourGPUModel.txt
   ```
   This will save the benchmark results to the `benchmarks` folder.

2. **Naming Convention**  
   Please use your GPU model as the filename, such as: `RTX4090.txt`, `A100.txt`, etc.

3. **Submit Your Data**  
   Add your benchmark text file to the `benchmarks/` directory and submit it via a Pull Request.

> If you have new benchmark data, contributions are welcome!

