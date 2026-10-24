# dsh-openfoam-doctor — OpenFOAM 算例医生（DSH 插件）

> OpenFOAM 最贵的错误不报错：steadyState 配 timeStep 写出几百个时间目录、限幅器设成 1 导致 k/epsilon 变负、`nNonOrthogonalCorrectors 0` 配斜网格让残差平着走、上一次运行留下的时间目录让重启从错的时刻开始。这个插件把这些**静默失败**在跑之前找出来，并且能真的在 WSL 里跑 checkMesh / blockMesh / foamRun。

六个 agent 工具：算例体检、字典直读、算例清单、WSL 执行、日志解析、环境探测。确定性文本分析——**不调 LLM**，所以答错就是规则有 bug，可以提 issue。

## 安装

```sh
dsh plugin --profile desktop add @bushizhanghan/dsh-openfoam-doctor
```

重启 DSH 后生效。算例一般在 WSL 里，所以配置里可指定 distro：

```yaml
- id: openfoam-doctor
  name: "@bushizhanghan/dsh-openfoam-doctor"
  config:
    distro: Ubuntu-24.04
    timeoutMs: 600000
```

## Agent 工具

| 工具 | 作用 |
|---|---|
| `of_check` | 体检算例：25 类静默错误，每条带 `fix` 文案。可按字典范围查（controlDict/fvSchemes/fvSolution/blockMeshDict/boundaries/times） |
| `of_read_dict` | 把任意 OpenFOAM 字典读成 JSON——回答「writeInterval 是多少」「inlet 用什么 BC」不用开 WSL |
| `of_list_cases` | 扫描目录列出所有算例：solver、稳态/瞬态、endTime、场文件、残留时间目录、有无 blockMesh/snappy |
| `of_run` | 在 WSL 里跑命令：checkMesh、blockMesh、snappyHexMesh、foamRun（可 mpirun 并行）、decomposePar、foamToVTK 等（白名单制） |
| `of_log` | 解析日志：checkMesh 指标 + 超范围判定；运行日志的末迭代、残差地板、致命错误 |
| `of_env` | 探测 OpenFOAM 环境：安装位置、版本、路径转换、WSL 可达性 |

## 它查什么

### 数值格式（最 silent 的一类）
| 规则 | 抓什么 |
|---|---|
| `limiter-wide-open` | `limitedLinear 1` = 限幅器形同虚设 → 高雷诺壁面区负 k/epsilon，「跑完了但图不对」 |
| `unbounded-scalar-advection` | `div(phi,k)` 等输运标量用无界 Gauss linear → 陡梯度处过冲 |
| `unbounded-viscous` | `div((nuEff*dev2(T(grad(U)))))` 没 `bounded` → 斜网格壁面速度尖刺 |
| `no-nonortho-correctors` | 斜网格上 `nNonOrthogonalCorrectors 0` → SIMPLE 残差平台，像不收敛其实是离散误差 |
| `loose-tolerance` / `loose-reltol` | 线性求解容差太松 → 压力残差再也降不下去 |

### 运行控制
| 规则 | 抓什么 |
|---|---|
| `steady-write-flood` | steadyState + `writeControl timeStep` → 每次写入都成一个时间目录 |
| `no-purge` | `purgeWrite 0` + 长扫描 → 磁盘无限增长 |
| `write-interval-fractional` | `writeInterval` 非整数步数 → 静默截断 |
| `stray-time-dirs` | 上次运行留下的时间目录 → 容易从错的时刻重启、foamToVTK 转换全部目录 |

### 结构错误（直接崩）
`missing-file`、`no-ddt`、`no-grad`、`no-laplacian`、`no-internal-field`、`no-boundary-field`、`block-vertex-mismatch`、`vertex-count`、`start-after-end`

### 网格质量（checkMesh 指标）
aspect ratio > 1000、non-orthogonality > 70°、skewness > 4，附违规面数

## 一个真实的例子

对用户自己的街道峡谷算例（OpenFOAM 11，snappy 网格，82238 cells）跑 `of_check` + `of_run checkMesh`：

```
! div(phi,k) uses limitedLinear 1 (limiter effectively disabled)
    fix Use limitedLinear 0.5, or switch to limitedLinearV 1 with a velocity field.
! div(phi,epsilon) uses limitedLinear 1 (limiter effectively disabled)
! div((nuEff*dev2(T(grad(U))))) is not bounded
! purgeWrite is 0 on a run that writes many times

checkMesh: cells 82238, non-orthogonality 69.98°, skewness 22.28 (734 faces), failed 1 check
```

这四条正是「图看着对但不敢信」的完整解释链。

## 设计取舍

- **OpenFOAM 字典自己解析**：它的格式带 C++ 横幅（转义反斜杠）、`/* */` 与 `//` 注释、`"(U|k|epsilon)"` 引号键、括号列表。通用解析器要么被横幅噎住，要么静默丢条目，所以 engine 里是一个 200 行的专用解析器（先剥注释再走大括号）。
- **只读优先**：`of_check` / `of_read_dict` / `of_list_cases` / `of_log` / `of_env` 全部只读；`of_run` 走命令白名单，不做任意 shell。
- **确定性**：没有 LLM 调用。规则错了你可以直接看规则——每条 finding 都带 `rule` 名。
- **路径在边界转换**：Windows 路径 ↔ `/mnt/` 路径在工具入口转换一次，之后全用一套。

## 开发

```sh
node --test test/    # 13 个单测（含真实算例 fixture）+ 11 项集成测试
```

`fixtures/SWR/` 是从一台真机 WSL 里拷来的算例（controlDict / fvSchemes / fvSolution / 0/U / constant/polyMesh / log.foamRun），`fixtures/log.checkMesh.sample` 是真 checkMesh 输出——测试断言的就是这些真实文件，不是手写的玩具样本。

## License

MIT
