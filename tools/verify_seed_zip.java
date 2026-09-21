/**
 * 首启快照校验：App 里那段「解 seed.zip」的代码，用**同一套 Java API** 在桌面上跑一遍，
 * 证明中文文件名（书名 / 章节名 / 设定名）解出来是原样，不会被 zip 编码搞乱。
 *
 * 背景：aapt2 打进 assets 的中文资源名不带 UTF-8 标记，读出来对不对要看系统实现；
 * 所以快照改成我们自己打的 zip + 显式 UTF-8 解码（见 build.sh 第 3 步、MainActivity.unzipAsset）。
 * 这个脚本就是把 unzipAsset 的解码口径单独拎出来验：
 *   javac -encoding UTF-8 tools/verify_seed_zip.java -d /tmp/seedverify
 *   java -cp /tmp/seedverify verify_seed_zip <seed.zip> <data/books>
 */
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.TreeSet;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public class verify_seed_zip {
    static int fail = 0;

    static void check(String name, boolean ok, String why) {
        System.out.println((ok ? "  \u2713 " : "  \u2717 ") + name + (ok ? "" : "   \u2014\u2014 " + why));
        if (!ok) fail++;
    }

    static String sha256(byte[] b) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : d) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    public static void main(String[] args) throws Exception {
        Path zip = Paths.get(args[0]);
        Path books = Paths.get(args[1]);
        check("A1 seed.zip 在", Files.isRegularFile(zip), zip.toString());

        List<String> names = new ArrayList<>();
        List<byte[]> bodies = new ArrayList<>();
        InputStream raw = Files.newInputStream(zip);
        ZipInputStream zin = new ZipInputStream(raw, StandardCharsets.UTF_8);  // 跟 App 里同一行
        ZipEntry e;
        while ((e = zin.getNextEntry()) != null) {
            if (e.isDirectory()) { zin.closeEntry(); continue; }
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int r;
            while ((r = zin.read(buf)) > 0) bos.write(buf, 0, r);
            names.add(e.getName());
            bodies.add(bos.toByteArray());
            zin.closeEntry();
        }
        zin.close();

        List<String> disk = new ArrayList<>();
        try (java.util.stream.Stream<Path> st = Files.walk(books)) {
            st.filter(Files::isRegularFile)
              .forEach(p -> disk.add(books.relativize(p).toString().replace('\\', '/')));
        }
        Collections.sort(disk);

        check("A2 条目数跟磁盘上一致", names.size() == disk.size(),
              "zip " + names.size() + " vs 磁盘 " + disk.size());

        TreeSet<String> zn = new TreeSet<>(names), dn = new TreeSet<>(disk);
        check("A3 每个条目名都能跟磁盘上的中文路径对上（一个字不差）", zn.equals(dn),
              "只在 zip 里：" + diff(zn, dn) + " 只在磁盘上：" + diff(dn, zn));

        boolean mojibake = false, unsafe = false;
        for (String n : names) {
            if (n.contains("\uFFFD") || n.indexOf('\u00c3') >= 0) mojibake = true;   // 典型的乱码痕迹
            if (n.startsWith("/") || n.contains("..")) unsafe = true;
        }
        check("A4 没有乱码痕迹（\u00c3/\uFFFD 这类）", !mojibake, "有条目名像乱码");
        check("A5 没有绝对路径 / 目录穿越（..）", !unsafe, "危险条目名");

        int same = 0;
        for (int i = 0; i < names.size(); i++) {
            Path f = books.resolve(names.get(i));
            if (Files.isRegularFile(f) && sha256(bodies.get(i)).equals(sha256(Files.readAllBytes(f)))) same++;
        }
        check("A6 条目内容跟磁盘逐字节一致", same == names.size(), same + "/" + names.size());

        boolean hasCn = names.stream().anyMatch(n -> n.matches(".*[\\u4e00-\\u9fa5].*"));
        check("A7 确实有中文文件名的条目（不是拿纯英文样本糊过去）", hasCn, "没有中文条目");

        String sample = names.stream().filter(n -> n.matches(".*[\\u4e00-\\u9fa5].*")).findFirst().orElse("");
        System.out.println("     样本：" + sample);
        System.out.println(fail == 0 ? "\n全部通过" : "\n有 " + fail + " 项没过");
        System.exit(fail == 0 ? 0 : 1);
    }

    static String diff(TreeSet<String> a, TreeSet<String> b) {
        List<String> out = new ArrayList<>();
        for (String x : a) if (!b.contains(x)) out.add(x);
        if (out.size() > 3) return out.subList(0, 3) + " …(共 " + out.size() + ")";
        return out.toString();
    }
}
